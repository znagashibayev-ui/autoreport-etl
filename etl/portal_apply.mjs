#!/usr/bin/env node
// «Портал: запись в таблицу» (этап 5). Забирает заявки портала autoreport-portal (по OIDC-токену GitHub, без общих секретов),
// пишет их в таблицу All_Tokens так же, как старый портал Apps Script (soCommit / saveTokenToSheet):
//   лист Total — токен, кабинет, его название, цели Яндекса, Email; лист Email_Access — пара «дилер, почта»;
//   реестр MultiAccount_Universal — если кабинетов площадки больше одного; лист Onboarding_Audit — журнал портала.
// Затем первая выгрузка новых дилеров (TikTok, Яндекс — уже в GitHub) с 01.01.2026, синхронизация таблиц и снимки дашборда.
// Доступ: GCP_WIF_PROVIDER + GCP_SERVICE_ACCOUNT (роль «Редактор» в All_Tokens и в реестре), CLOUDFLARE_API_TOKEN — D1 (выгрузка).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tokenProvider } from './lib/google.mjs';
import { ALL_TOKENS_ID, readSheet } from './lib/sheets.mjs';
import { MA_REGISTRY_ID } from './lib/multiaccount.mjs';
import { cellEmails } from './lib/admin_sheets.mjs';
import { FIRST_ETL_START, GH_PLATFORMS, PLATFORMS, REGISTRY_TABS, planRegistry, planTotal, safeCell } from './lib/portal.mjs';

const PORTAL_URL = (process.env.PORTAL_URL || 'https://autoreport-connect.dm-astana-motors.kz').replace(/\/$/, '');
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const AUDIT = 'Onboarding_Audit';
const AUDIT_HEAD = ['Время', 'Событие', 'Email', 'Dealer_ID', 'Платформа', 'Детали'];
const summary = [];
const say = (s) => { console.log(s); summary.push(s); };

/* ---------- связь с порталом ---------- */

async function oidcToken() {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: u, ACTIONS_ID_TOKEN_REQUEST_TOKEN: t } = process.env;
  if (!u || !t) throw new Error('Нет OIDC GitHub: нужно permissions: id-token: write');
  const r = await fetch(u + '&audience=autoreport-portal', { headers: { Authorization: 'bearer ' + t } });
  const b = await r.json().catch(() => ({}));
  if (!b.value) throw new Error('GitHub не выдал OIDC-токен (HTTP ' + r.status + ')');
  return b.value;
}

export async function portalCall(path, body, fetchImpl = fetch, token) {
  const r = await fetchImpl(PORTAL_URL + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + (token || (await oidcToken())), 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.ok) throw new Error('Портал ' + path + ': ' + (b.error || 'HTTP ' + r.status));
  return b;
}

/* ---------- Google Sheets ---------- */

async function sheets(token, spreadsheet, path, method, body) {
  const res = await fetch(SHEETS_API + spreadsheet + path, {
    method, headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (out.error && out.error.message) || 'HTTP ' + res.status;
    throw new Error(res.status === 403 ? `нет права записи в таблицу ${spreadsheet}: дайте аккаунту autoreport-github@astana-motors-accounts.iam.gserviceaccount.com роль «Редактор»` : 'Google Sheets: ' + msg);
  }
  return out;
}

const q = (name) => "'" + name.replace(/'/g, "''") + "'";

async function update(token, spreadsheet, updates) {
  if (!updates.length) return;
  await sheets(token, spreadsheet, '/values:batchUpdate', 'POST', { valueInputOption: 'RAW', data: updates.map((u) => ({ range: u.range, values: [[u.value]] })) });
}

async function append(token, spreadsheet, sheet, rows) {
  if (!rows.length) return;
  await sheets(token, spreadsheet, `/values/${encodeURIComponent(q(sheet) + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, 'POST', { values: rows });
}

/** Время для журнала как в листе (дд.мм.гггг чч:мм:сс по Алматы) — его понимает sheetDate при синхронизации. */
export function almatyStamp(iso) {
  const d = new Date(new Date(iso).getTime() + 5 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/* ---------- одна заявка ---------- */

/** Повторная запись регистрации (после сбоя) не должна падать на «дилер уже есть», если строку создала эта же заявка. */
export function effectiveKind(totalRows, req) {
  if (req.kind !== 'register') return req.kind;
  const head = (totalRows[0] || []).map((h) => String(h || '').trim());
  const c = head.indexOf('Distr_Dealer_ID');
  const e = head.indexOf('Email');
  const row = totalRows.slice(1).find((r) => String((r || [])[c] || '').trim().toLowerCase() === req.dealer.toLowerCase());
  if (!row) return 'register';
  if (e > -1 && cellEmails(row[e]).includes(String(req.email).toLowerCase())) return 'update';
  return 'register'; // занят другим — planTotal выдаст ошибку
}

async function applyOne(token, req) {
  const notes = [];
  const total = await readSheet(token, ALL_TOKENS_ID, 'Total');
  const kind = effectiveKind(total, req);
  const plan = planTotal(total, { kind, dealer: req.dealer, email: req.email, goals: req.goals, chosen: req.chosen, tokens: req.tokens });
  if (plan.append) await append(token, ALL_TOKENS_ID, 'Total', [plan.append]);
  else await update(token, ALL_TOKENS_ID, plan.updates);
  notes.push(plan.append ? `Total: новая строка ${plan.row}` : `Total: строка ${plan.row}, ячеек ${plan.updates.length}`);
  if (plan.missing.length) notes.push('нет колонок: ' + plan.missing.join(', '));

  const ea = await readSheet(token, ALL_TOKENS_ID, 'Email_Access');
  const email = String(req.email).toLowerCase();
  const has = ea.slice(1).some((r) => String((r || [])[0] || '').trim().toLowerCase() === req.dealer.toLowerCase() && cellEmails((r || [])[1]).includes(email));
  if (!has) { await append(token, ALL_TOKENS_ID, 'Email_Access', [[safeCell(req.dealer), email]]); notes.push('Email_Access: добавлен доступ'); }

  for (const p of PLATFORMS) {
    const ids = (plan.registry && plan.registry[p]) || []; // новые кабинеты — добавляются к уже подключённым
    if (!ids.length) continue;
    const tab = REGISTRY_TABS[p];
    try {
      const reg = await readSheet(token, MA_REGISTRY_ID, tab);
      const rp = planRegistry(reg, tab, p, req.dealer, ids);
      if (rp.append) await append(token, MA_REGISTRY_ID, tab, [rp.append]);
      else await update(token, MA_REGISTRY_ID, rp.updates);
      notes.push(`реестр «${tab}»: +${rp.ids.length}`);
    } catch (e) {
      throw new Error(`Total записан, но реестр «${tab}» — нет: ${e.message}. Остальные кабинеты ${p} не будут выгружаться, пока реестр не записан (кнопка «Повторить»).`);
    }
  }
  return { kind, note: notes.join('; ') };
}

/* ---------- первая выгрузка ---------- */

function runEtl(platformKey, dealers, start) {
  say(`\n▶ Первая выгрузка ${platformKey}: ${dealers.join(', ')} с ${start || '1-го числа месяца'}`);
  const r = spawnSync(process.execPath, ['etl/run_platform.mjs'], {
    stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PLATFORM: platformKey, START: start, END: '', DEALERS: dealers.join(','), NO_WRITE: '0' }
  });
  if (r.stderr) process.stderr.write(r.stderr);
  // Причина ошибки — в заявку (раньше было только «см. Запуски ETL», а если выгрузка падала до записи в журнал, там пусто).
  const lines = String(r.stderr || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !/^at /.test(l));
  return { ok: r.status === 0, error: r.status === 0 ? '' : (lines.slice(-3).join(' · ') || 'код ' + r.status).slice(0, 300) };
}

async function dispatchSnapshots(dealers) {
  const tok = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!tok || !repo || !dealers.length) return;
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/snapshots.yml/dispatches`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'User-Agent': 'autoreport-portal' },
    body: JSON.stringify({ ref: 'main', inputs: { dealers: dealers.join(',') } })
  });
  say(r.status === 204 ? '▶ Запущены «Снимки дашборда» для новых дилеров.' : '⚠️ Снимки дашборда не запущены: HTTP ' + r.status);
}

async function main() {
  // OIDC-токен GitHub живёт минуты — берём новый на каждый вызов (выгрузка между вызовами идёт долго).
  const call = (path, body) => portalCall(path, body);
  const { requests, logs } = await call('/internal/pending', {});
  say(`Заявок к записи: ${requests.length}, событий журнала: ${logs.length}`);
  if (!requests.length && !logs.length) return;

  const token = tokenProvider([WRITE_SCOPE]);
  const results = [];
  const done = [];
  for (const req of requests) {
    try {
      const r = await applyOne(token, req);
      results.push({ id: req.id, ok: true, note: r.note, event: r.kind === 'register' ? 'REGISTERED' : 'TOKENS_UPDATED', email: req.email, dealer: req.dealer,
        platform: Object.keys(req.chosen).join(',') });
      done.push({ ...req, kind: r.kind });
      say(`✅ ${req.dealer} (${r.kind}): ${r.note}`);
    } catch (e) {
      results.push({ id: req.id, ok: false, note: String(e.message).slice(0, 900), event: 'WRITE_FAILED', email: req.email, dealer: req.dealer });
      say(`❌ ${req.dealer}: ${e.message}`);
    }
  }

  // Журнал портала → лист Onboarding_Audit (он же раздел «Входы и журнал» админки после синхронизации).
  let logIds = [];
  if (logs.length) {
    try {
      const audit = await readSheet(token, ALL_TOKENS_ID, AUDIT).catch(() => null);
      if (!audit) await append(token, ALL_TOKENS_ID, AUDIT, [AUDIT_HEAD]);
      await append(token, ALL_TOKENS_ID, AUDIT, logs.map((l) => [almatyStamp(l.at), l.event, l.email || '', l.dealer || '', l.platform || '', safeCell(l.detail || '')]));
      logIds = logs.map((l) => l.id);
    } catch (e) {
      say('⚠️ Журнал не записан в Onboarding_Audit: ' + e.message);
    }
  }
  await call('/internal/result', { results, logIds });

  // Первая выгрузка — с 01.01.2026, как кнопка «Загрузить данные в базу» старого портала (runAllPlatformsETL), и при новом токене тоже:
  // у дилера могло не быть данных по этой площадке вовсе.
  const etl = {};
  for (const p of Object.keys(GH_PLATFORMS)) {
    for (const [mode, start] of [['register', FIRST_ETL_START], ['update', FIRST_ETL_START]]) {
      const reqs = done.filter((r) => r.kind === mode && r.chosen[p] && r.chosen[p].length);
      if (!reqs.length) continue;
      const res = runEtl(GH_PLATFORMS[p], [...new Set(reqs.map((r) => r.dealer))], start);
      for (const r of reqs) {
        (etl[r.id] = etl[r.id] || {})[p] = res.ok ? 'выгружено с ' + (start || '1-го числа месяца')
          : 'ошибка выгрузки с ' + (start || '1-го числа месяца') + ': ' + res.error + ' (подробно — админка → «Запуски ETL»)';
      }
    }
  }
  for (const r of done) {
    for (const p of Object.keys(r.chosen)) if (!GH_PLATFORMS[p]) (etl[r.id] = etl[r.id] || {})[p] = 'загрузит ночной Apps Script';
  }
  const etlResults = Object.entries(etl).map(([id, v]) => ({ id: Number(id), etl: v, etlOnly: true }));
  if (etlResults.length) await call('/internal/result', { results: etlResults });

  if (done.length) {
    say('\n▶ Синхронизация таблиц (админка и доступы нового дашборда)');
    spawnSync(process.execPath, ['etl/sync_sheets.mjs'], { stdio: 'inherit', env: process.env });
    await dispatchSnapshots([...new Set(done.filter((r) => r.kind === 'register').map((r) => r.dealer))]);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('portal_apply.mjs')) {
  main().catch((e) => { say('❌ ' + e.message); process.exitCode = 1; }).finally(() => {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  });
}
