#!/usr/bin/env node
// Сверка снимков дашборда со старым дашбордом: старый строит снимки из BigQuery daily_statistics
// (Cube_Builder.gs), поэтому эталон — та же выборка из BigQuery. Снимки читаются из R2 — ровно то, что отдаёт сайт.
// Итог: таблица «старый / новый / разница» по дилеру × площадке × месяцу → журнал и D1 migration_check (tbl = 'snap').
//
// Параметры: DEALERS (по умолчанию Distributor_BMW, Dealer_BMW_Almaty, Distributor_Haval), MONTHS (по умолчанию 2026-09,2026-10).
// Доступ: как у ночной выгрузки (GCP_WIF_PROVIDER + GCP_SERVICE_ACCOUNT, CLOUDFLARE_API_TOKEN).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ETL_SCOPES, bqSelect, tokenProvider } from './lib/google.mjs';
import { d1ExecFile, r2Get } from './lib/cloudflare.mjs';
import { buildInserts } from './lib/sql.mjs';
import { decodeSnapshot, totalsByPlatformMonth } from './lib/snapshot.mjs';
import { snapKey } from './build_snapshots.mjs';

const EPS_KZT = 1; // ₸: снимок округляет расход до копеек на строку
const list = (v, d) => (v || d).split(',').map((s) => s.trim()).filter(Boolean);

/** Сравнение агрегатов: эталон BigQuery против снимка. Экспортируется для тестов. */
export function compareSnapshot(dealer, months, bqRows, snapTotals) {
  const key = (p, m) => p + '|' + m;
  const map = new Map();
  for (const r of bqRows) map.set(key(r.Platform, r.month), { Dealer_ID: dealer, Platform: r.Platform, month: r.month, old: { spend: +r.spend || 0, conv: +r.conv || 0, n: +r.n || 0 }, now: { spend: 0, conv: 0 } });
  for (const t of snapTotals) {
    if (!months.includes(t.month)) continue;
    const k = key(t.Platform, t.month);
    if (!map.has(k)) map.set(k, { Dealer_ID: dealer, Platform: t.Platform, month: t.month, old: { spend: 0, conv: 0, n: 0 }, now: { spend: 0, conv: 0 } });
    map.get(k).now = { spend: Math.round(t.kzt * 100) / 100, conv: t.cnv };
  }
  return [...map.values()].map((r) => ({ ...r, ok: Math.abs(r.old.spend - r.now.spend) <= EPS_KZT && r.old.conv === r.now.conv }))
    .sort((a, b) => (a.month + a.Platform).localeCompare(b.month + b.Platform));
}

async function main() {
  const dealers = list(process.env.DEALERS, 'Distributor_BMW,Dealer_BMW_Almaty,Distributor_Haval');
  const months = list(process.env.MONTHS, '2026-09,2026-10');
  const token = tokenProvider(ETL_SCOPES);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapv-'));
  const runId = 'snap-' + new Date().toISOString().replace(/[:.]/g, '-');
  const fmt = (v) => Math.round(v).toLocaleString('ru-RU');
  const all = [];
  console.log('| Дилер | Месяц | Площадка | Расход старый, ₸ | Расход новый, ₸ | Разница | Конв. старые / новые | Сверка |');
  console.log('|---|---|---|---:|---:|---:|---:|---|');
  for (const dealer of dealers) {
    const file = path.join(dir, dealer + '.json.gz');
    r2Get(snapKey(dealer), file);
    const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    const { rows } = await bqSelect(await token(), {
      project: 'astana-motors-accounts', location: 'EU',
      sql: `SELECT Platform, FORMAT_DATE('%Y-%m', Date) AS month, COUNT(*) AS n, ROUND(SUM(Spend_KZT), 2) AS spend, SUM(Conversions) AS conv ` +
        `FROM \`astana-motors-accounts.marketing_data.daily_statistics\` WHERE Dealer_ID = '${dealer.replace(/'/g, "\'")}' ` +
        `AND FORMAT_DATE('%Y-%m', Date) IN (${months.map((m) => `'${m}'`).join(', ')}) GROUP BY 1, 2`
    });
    for (const r of compareSnapshot(dealer, months, rows, totalsByPlatformMonth(decodeSnapshot(snap)))) {
      all.push(r);
      const d = r.now.spend - r.old.spend;
      console.log(`| ${dealer} | ${r.month} | ${r.Platform} | ${fmt(r.old.spend)} | ${fmt(r.now.spend)} | ${(d >= 0 ? '+' : '') + fmt(d)} | ${r.old.conv} / ${r.now.conv} | ${r.ok ? '✅' : '⚠️'} |`);
    }
  }
  const ok = all.filter((r) => r.ok).length;
  console.log(`\nСовпало: ${ok} из ${all.length} (допуск ${EPS_KZT} ₸ на округление). Снимки собраны: ${dealers.join(', ')}.`);
  const cols = ['run_id', 'tbl', 'month', 'Dealer_ID', 'Platform', 'bq_rows', 'new_rows', 'bq_spend_kzt', 'new_spend_kzt', 'bq_conversions', 'new_conversions', 'ok'];
  d1ExecFile(buildInserts('migration_check', cols, all.map((r) => ({ run_id: runId, tbl: 'snap', month: r.month, Dealer_ID: r.Dealer_ID, Platform: r.Platform,
    bq_rows: r.old.n, new_rows: null, bq_spend_kzt: r.old.spend, new_spend_kzt: r.now.spend, bq_conversions: r.old.conv, new_conversions: r.now.conv, ok: r.ok ? 1 : 0 }))).join('\n'), 'snap-checks');
}

if (process.argv[1] && /verify_snapshots\.mjs$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
