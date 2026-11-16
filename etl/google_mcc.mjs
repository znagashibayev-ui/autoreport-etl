#!/usr/bin/env node
// «Google Ads: токен MCC». Выгрузка Google Ads ходит в аккаунты через MCC 5297548449 (login-customer-id), поэтому любому
// аккаунту под MCC подходит один и тот же refresh token сотрудника с доступом к MCC — личный токен дилера не нужен.
// Задание:
//   1) находит в листе Total работающий Google_Token с доступом к MCC (пробует токены других дилеров);
//   2) читает список всех аккаунтов под MCC;
//   3) дилерам, у которых Google_Customer_ID заполнен, а Google_Token пуст, вписывает этот токен — только если аккаунт под MCC;
//   4) показывает аккаунты MCC, которые не привязаны ни к одному дилеру (их ID нужно вписать в Total вручную — к какому дилеру
//      относится аккаунт, программа не угадывает);
//   5) при записи — загрузка Google Ads этих дилеров в D1 с START (по умолчанию 2026-01-01) и синхронизация таблиц.
// APPLY=1 — писать; по умолчанию только отчёт. Токены не печатаются.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tokenProvider } from './lib/google.mjs';
import { ALL_TOKENS_ID, readSheet } from './lib/sheets.mjs';
import { MA_REGISTRY_ID, MA_TABS, parseRegistry } from './lib/multiaccount.mjs';
import { GOOGLE_LOGIN_CUSTOMER_ID, googleAccessToken } from './platforms/googleads.mjs';

const API = 'https://googleads.googleapis.com/v24/customers/';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MAX_DONORS = 10;
const summary = [];
const say = (s) => { console.log(s); summary.push(s); };

const str = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(0) : String(v).trim());
export const normCid = (v) => str(v).replace(/-/g, '');
const ids = (v) => str(v).split(/[,;\s]+/).map(normCid).filter(Boolean);

function colLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Токены-кандидаты из Total: самые частые первыми (обычно это токен администратора MCC). */
export function donorCandidates(rows) {
  const h = (rows[0] || []).map(str);
  const cTok = h.indexOf('Google_Token');
  if (cTok === -1) throw new Error('В листе Total нет колонки Google_Token');
  const by = new Map();
  for (const r of rows.slice(1)) {
    const t = str((r || [])[cTok]).split(/[,;\s]+/)[0];
    const d = str((r || [])[0]);
    if (!t || !d) continue;
    const e = by.get(t) || { token: t, dealers: [] };
    e.dealers.push(d);
    by.set(t, e);
  }
  return [...by.values()].sort((a, b) => b.dealers.length - a.dealers.length);
}

/**
 * План: кому вписать токен MCC и какие аккаунты MCC ни к кому не привязаны.
 * @param rows лист Total; @param children Map(id → name) аккаунтов под MCC; @param registry parseRegistry(вкладка «Google Ads»)
 */
export function planMccFill(rows, children, registry = {}, invalid = new Set()) {
  const h = (rows[0] || []).map(str);
  const cTok = h.indexOf('Google_Token');
  const cId = h.indexOf('Google_Customer_ID');
  if (cTok === -1 || cId === -1) throw new Error('В листе Total нет колонок Google_Token / Google_Customer_ID');
  const fill = []; const notInMcc = []; const linked = new Set();
  for (const e of Object.values(registry)) for (const a of e.accounts) linked.add(normCid(a));
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const dealer = str(r[0]);
    const list = ids(r[cId]);
    list.forEach((x) => linked.add(x));
    const tok = str(r[cTok]).split(/[,;s]+/)[0];
    if (!dealer || !list.length || (tok && !invalid.has(tok))) continue; // рабочий токен не трогаем; пустой или отозванный — заменяем
    const outside = list.filter((x) => !children.has(x));
    if (outside.length) { notInMcc.push({ dealer, ids: outside }); continue; }
    fill.push({ dealer, row: i + 1, cell: `'Total'!${colLetter(cTok)}${i + 1}`, ids: list, names: list.map((x) => children.get(x)), replaced: !!tok });
  }
  const unlinked = [...children.entries()].filter(([id]) => !linked.has(id)).map(([id, name]) => ({ id, name }));
  return { fill, notInMcc, unlinked };
}

/* ---------- Google Ads API ---------- */

/** Аккаунты под MCC (не управляющие, включённые): Map(id → название). null — у токена нет доступа к MCC. */
export async function mccChildren(accessToken, developerToken, fetchImpl = fetch) {
  const res = await fetchImpl(API + GOOGLE_LOGIN_CUSTOMER_ID + '/googleAds:search', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'developer-token': developerToken, 'login-customer-id': GOOGLE_LOGIN_CUSTOMER_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client' })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) return { error: String((j.error && j.error.message) || 'HTTP ' + res.status).slice(0, 200) };
  const out = new Map();
  for (const r of j.results || []) {
    const c = r.customerClient || {};
    if (!c.id || c.manager === true || (c.status && c.status !== 'ENABLED')) continue;
    out.set(String(c.id), c.descriptiveName || String(c.id));
  }
  return { children: out };
}

/* ---------- запуск ---------- */

async function main() {
  const apply = process.env.APPLY === '1';
  const start = process.env.START || '2026-01-01';
  const keys = { clientId: process.env.GOOGLE_ADS_CLIENT_ID, clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET, developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN };
  if (!keys.clientId || !keys.clientSecret || !keys.developerToken) throw new Error('Нет секретов GitHub GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_DEVELOPER_TOKEN');

  say(`# Google Ads: токен MCC ${GOOGLE_LOGIN_CUSTOMER_ID} — ${apply ? 'ЗАПИСЬ' : 'только отчёт (APPLY=0)'}`);
  const token = tokenProvider([WRITE_SCOPE]);
  const total = await readSheet(token, ALL_TOKENS_ID, 'Total');
  const registry = parseRegistry(await readSheet(token, MA_REGISTRY_ID, MA_TABS.Google).catch(() => []), 'Google');

  let donor = null; let children = null;
  for (const c of donorCandidates(total).slice(0, MAX_DONORS)) {
    const at = await googleAccessToken(c.token, keys).catch(() => null);
    if (!at) { say(`- токен дилеров ${c.dealers.slice(0, 3).join(', ')}${c.dealers.length > 3 ? '…' : ''}: недействителен`); continue; }
    const r = await mccChildren(at, keys.developerToken);
    if (r.error) { say(`- токен дилеров ${c.dealers.slice(0, 3).join(', ')}: нет доступа к MCC (${r.error})`); continue; }
    donor = c; children = r.children;
    break;
  }
  if (!donor) throw new Error('Ни один Google_Token из листа Total не открывает MCC ' + GOOGLE_LOGIN_CUSTOMER_ID + '. Нужен хотя бы один рабочий токен сотрудника с доступом к MCC.');
  say(`✅ Токен MCC найден (сейчас у ${donor.dealers.length} дилеров, например ${donor.dealers.slice(0, 3).join(', ')}). Аккаунтов под MCC: ${children.size}.`);

  // отозванные токены (invalid_grant) тоже заменяются токеном MCC — сеть/сбой Google токен недействительным не делает
  const invalid = new Set();
  for (const c of donorCandidates(total)) {
    if (c.token === donor.token) continue;
    try { if (!(await googleAccessToken(c.token, keys))) invalid.add(c.token); } catch { /* нет связи — не трогаем */ }
  }
  if (invalid.size) say(`Отозванных токенов Google в листе Total: ${invalid.size} — их дилерам впишется токен MCC (если аккаунт под MCC).`);
  const plan = planMccFill(total, children, registry, invalid);
  say(`\n## Дилеры без рабочего токена Google, аккаунт под MCC — ${plan.fill.length}`);
  for (const f of plan.fill) say(`- ${f.dealer}${f.replaced ? ' (токен был отозван)' : ''}: ${f.ids.map((x, i) => `${x} (${f.names[i]})`).join(', ')} → ячейка ${f.cell}`);
  if (plan.notInMcc.length) {
    say(`\n## ⚠️ Без токена, и аккаунт НЕ под MCC — ${plan.notInMcc.length} (нужно привязать аккаунт к MCC или проверить ID)`);
    for (const n of plan.notInMcc) say(`- ${n.dealer}: ${n.ids.join(', ')}`);
  }
  if (plan.unlinked.length) {
    say(`\n## Аккаунты MCC, не привязанные ни к одному дилеру — ${plan.unlinked.length}`);
    say('Чтобы они попали в отчёт, впишите ID в колонку Google_Customer_ID нужного дилера в листе Total (несколько — через запятую) и запустите задание ещё раз.');
    for (const u of plan.unlinked) say(`- ${u.id} — ${u.name}`);
  }

  if (!apply || !plan.fill.length) {
    if (!apply && plan.fill.length) say('\nЭто проверка. Чтобы записать, запустите задание с «Записать = 1».');
    return;
  }

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ALL_TOKENS_ID}/values:batchUpdate`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data: plan.fill.map((f) => ({ range: f.cell, values: [[donor.token]] })) })
  });
  if (!res.ok) throw new Error('Запись в лист Total не удалась: HTTP ' + res.status + (res.status === 403 ? ' — нужна роль «Редактор» для autoreport-github@astana-motors-accounts.iam.gserviceaccount.com' : ''));
  // проверка: перечитать и убедиться, что токен на месте
  const after = await readSheet(token, ALL_TOKENS_ID, 'Total');
  const cTok = (after[0] || []).map(str).indexOf('Google_Token');
  const ok = plan.fill.filter((f) => str((after[f.row - 1] || [])[cTok]) === donor.token).map((f) => f.dealer);
  say(`\n✅ Токен записан: ${ok.length} из ${plan.fill.length} (${ok.join(', ')})`);
  if (ok.length !== plan.fill.length) process.exitCode = 1;
  if (!ok.length) return;

  say(`\n▶ Загрузка Google Ads в D1 с ${start}: ${ok.join(', ')}`);
  const r = spawnSync(process.execPath, ['etl/run_platform.mjs'], {
    stdio: 'inherit', env: { ...process.env, PLATFORM: 'google', START: start, END: '', DEALERS: ok.join(','), NO_WRITE: '0' }
  });
  if (r.status !== 0) { say('❌ Загрузка завершилась с ошибкой — подробности выше в журнале шага.'); process.exitCode = 1; }
  say('\n▶ Синхронизация таблиц (админка и портал увидят токен)');
  spawnSync(process.execPath, ['etl/sync_sheets.mjs'], { stdio: 'inherit', env: process.env });
}

if (process.argv[1] && process.argv[1].endsWith('google_mcc.mjs')) {
  main().catch((e) => { say('❌ ' + e.message); process.exitCode = 1; }).finally(() => {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  });
}
