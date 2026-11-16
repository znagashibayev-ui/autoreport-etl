#!/usr/bin/env node
// Текущие дневные бюджеты кампаний из кабинетов дилеров, у которых есть медиаплан (cc_mp_sheets), → D1 cc_budgets.
// Шаг задания «Пересчёт недолётов» (каждый час и кнопка «Перечитать медиаплан»). Кабинеты только читаются.
// Окружение: DEALERS — только эти Dealer_ID через запятую; GOOGLE_ADS_* — ключи Google Ads; GCP_* — чтение таблиц; CLOUDFLARE_* — D1.

import fs from 'node:fs';
import { SHEETS_SCOPE, tokenProvider } from './lib/google.mjs';
import { ALL_TOKENS_ID, readSheet } from './lib/sheets.mjs';
import { buildInserts, sqlLiteral } from './lib/sql.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { MA_REGISTRY_ID, MA_TABS, expandAccounts, parseRegistry } from './lib/multiaccount.mjs';
import { googleBudgets, metaBudgets, tiktokBudgets, yandexBudgets } from './lib/budgets.mjs';

const COLS = ['dealer', 'platform', 'account', 'campaign', 'status', 'daily', 'total', 'currency', 'mode', 'note', 'checked'];
const PARALLEL = 4;
const summary = [];
const say = (s) => { console.log(s); summary.push(s); };
const str = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(0) : String(v).trim());

/** Кабинеты дилеров по площадкам из листа Total (+ реестр нескольких кабинетов). */
export function accountsOf(total, registries, wanted) {
  const want = new Set(wanted.map((d) => d.toLowerCase()));
  const out = [];
  const add = (platform, accCol, tokCol, regKey) => {
    const rows = regKey ? expandAccounts(total, accCol, tokCol, regKey, registries[regKey] || {}) : total;
    const h = (rows[0] || []).map(str);
    const cA = h.indexOf(accCol); const cT = h.indexOf(tokCol);
    if (cA === -1 || cT === -1) return;
    const seen = new Set();
    for (const r of rows.slice(1)) {
      const dealer = str((r || [])[0]); const account = str(r[cA]); const token = str(r[cT]).split(/[,;\s]+/)[0];
      if (!dealer || !account || !token || !want.has(dealer.toLowerCase())) continue;
      for (const acc of regKey ? [account] : account.split(/[,;\s]+/).filter(Boolean)) {
        const key = dealer + '|' + acc;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ dealer, platform, account: acc, token });
      }
    }
  };
  add('Meta', 'Meta_Ad_Account_ID', 'Meta_Token', 'Meta');
  add('TikTok', 'TikTok_Advertiser_ID', 'TikTok_Token', 'TikTok');
  add('Google Ads', 'Google_Customer_ID', 'Google_Token', 'Google');
  add('Yandex', 'Yandex_Client_Login', 'Yandex_Token', null);
  return out;
}

async function fetchOne(a, keys) {
  if (a.platform === 'Meta') return metaBudgets(a.account, a.token);
  if (a.platform === 'TikTok') return tiktokBudgets(a.account, a.token);
  if (a.platform === 'Google Ads') return googleBudgets(a.account, a.token, keys);
  return yandexBudgets(a.account, a.token);
}

async function main() {
  const only = String(process.env.DEALERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const dealers = only.length ? only : d1Query('SELECT DISTINCT dealer FROM cc_mp_sheets').map((r) => r.dealer);
  if (!dealers.length) { say('Медиапланов в базе нет — бюджеты не читаются.'); return; }
  const token = tokenProvider([SHEETS_SCOPE]);
  const total = await readSheet(token, ALL_TOKENS_ID, 'Total');
  const registries = {};
  for (const p of ['Meta', 'TikTok', 'Google']) {
    try { registries[p] = parseRegistry(await readSheet(token, MA_REGISTRY_ID, MA_TABS[p]), p); } catch (e) { say(`⚠️ Реестр «${MA_TABS[p]}» не прочитан — только кабинеты из Total. ${e.message}`); }
  }
  const keys = { clientId: process.env.GOOGLE_ADS_CLIENT_ID, clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET, developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN };
  let list = accountsOf(total, registries, dealers);
  if (!keys.clientId || !keys.clientSecret || !keys.developerToken) {
    say('⚠️ Нет секретов GOOGLE_ADS_* — бюджеты Google Ads не читаются.');
    list = list.filter((a) => a.platform !== 'Google Ads');
  }
  say(`# Дневные бюджеты из кабинетов: ${dealers.length} дилеров, ${list.length} кабинетов`);

  const now = new Date().toISOString();
  const rows = []; const errors = [];
  let i = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (i < list.length) {
      const a = list[i++];
      try {
        for (const c of await fetchOne(a, keys)) {
          if (!c.campaign) continue;
          rows.push({ dealer: a.dealer, platform: a.platform, account: a.account, campaign: String(c.campaign).slice(0, 300), status: c.status, daily: c.daily,
            total: c.total, currency: c.currency, mode: c.mode, note: '', checked: now });
        }
      } catch (e) {
        errors.push(`${a.dealer} · ${a.platform} ${a.account}: ${e.message}`);
        rows.push({ dealer: a.dealer, platform: a.platform, account: a.account, campaign: '', status: '', daily: null, total: null, currency: '', mode: 'error',
          note: String(e.message).slice(0, 300), checked: now });
      }
    }
  }));
  // одна кампания с одинаковым именем в кабинете дважды — оставляем первую (ключ таблицы)
  const uniq = new Map();
  for (const r of rows) { const k = [r.dealer, r.platform, r.account, r.campaign].join('|'); if (!uniq.has(k)) uniq.set(k, r); }
  const touched = [...new Set(list.map((a) => a.dealer))];
  if (touched.length) {
    d1ExecFile([`DELETE FROM cc_budgets WHERE dealer IN (${touched.map(sqlLiteral).join(', ')});`, ...buildInserts('cc_budgets', COLS, [...uniq.values()])].join('\n') + '\n', 'budgets');
  }
  const withDaily = [...uniq.values()].filter((r) => r.daily).length;
  say(`Кампаний: ${uniq.size - errors.length}, с дневным бюджетом: ${withDaily}. Кабинетов с ошибкой: ${errors.length}.`);
  for (const e of errors.slice(0, 30)) say('⚠️ ' + e);
}

if (process.argv[1] && process.argv[1].endsWith('budgets.mjs')) {
  main().catch((e) => { say('❌ ' + e.message); process.exitCode = 1; }).finally(() => {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  });
}
