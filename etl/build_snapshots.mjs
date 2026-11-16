#!/usr/bin/env node
// Снимки дашборда дилеров (этап 4 переезда): D1 daily_statistics → snap/<Dealer_ID>.json.gz в R2.
// Замена Cube_Builder.gs + Fast_Bundle.gs. D1 только читается (SELECT), запись — только в R2.
//
// Параметры (переменные окружения или --ключ значение):
//   DEALERS   — только эти Dealer_ID через запятую (пусто = все из daily_statistics)
//   OUT       — папка, куда дополнительно положить файлы (для проверки); по умолчанию — временная
//   NO_UPLOAD — 1 = собрать и проверить, в R2 не класть
// Доступ: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (в GitHub Actions) или wrangler login (локально).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { d1Query, r2Put } from './lib/cloudflare.mjs';
import { sqlLiteral } from './lib/sql.mjs';
import { encodeSnapshot, snapshotSql, totalsByPlatformMonth, decodeSnapshot } from './lib/snapshot.mjs';

export const SNAP_PREFIX = 'snap/';
export const MANIFEST_KEY = SNAP_PREFIX + '_manifest.json';
/** Предел размера снимка (бюджет дашборда). Больше — ошибка запуска. */
export const SNAP_MAX_GZ_BYTES = 300 * 1024;

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[name.toUpperCase()] || fallback;
}

/** Имя файла в R2: Dealer_ID как есть, но только безопасные символы. */
export function snapKey(dealerId) {
  if (!/^[A-Za-z0-9_.\-]+$/.test(dealerId)) throw new Error('Недопустимый Dealer_ID для имени файла: ' + dealerId);
  return SNAP_PREFIX + dealerId + '.json.gz';
}

/** Собрать один снимок: строки → JSON → gzip + контрольные суммы. */
export function buildOne(dealerId, rows, built) {
  const snap = encodeSnapshot(dealerId, rows, built);
  const json = JSON.stringify(snap);
  const gz = zlib.gzipSync(json, { level: 9 });
  // Самопроверка: распакованный снимок даёт те же суммы, что исходные строки SQL.
  const back = totalsByPlatformMonth(decodeSnapshot(JSON.parse(zlib.gunzipSync(gz).toString('utf8'))));
  const src = totalsByPlatformMonth(rows);
  if (back.length !== src.length) throw new Error(dealerId + ': число срезов снимка не совпало с SQL');
  for (let i = 0; i < src.length; i++) {
    for (const k of ['imp', 'clk', 'cnv']) {
      if (Math.abs(back[i][k] - Math.round(src[i][k])) > 0.5 * snap.n) throw new Error(dealerId + ': ' + k + ' снимка ≠ SQL');
    }
    if (Math.abs(back[i].kzt - src[i].kzt) > 0.005 * snap.n + 0.01) throw new Error(dealerId + ': расход снимка ≠ SQL');
  }
  return {
    snap, gz,
    entry: {
      id: dealerId,
      rows: snap.n,
      bytes: gz.length,
      raw: Buffer.byteLength(json),
      etag: crypto.createHash('sha256').update(gz).digest('hex').slice(0, 20),
      first: snap.base,
      last: snap.last
    }
  };
}

async function main() {
  const t0 = Date.now();
  const only = arg('dealers').split(',').map((s) => s.trim()).filter(Boolean);
  const noUpload = arg('no_upload') === '1';
  const outDir = arg('out') || fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  fs.mkdirSync(outDir, { recursive: true });

  const all = d1Query("SELECT DISTINCT Dealer_ID AS id FROM daily_statistics WHERE Dealer_ID IS NOT NULL AND TRIM(Dealer_ID) != '' ORDER BY 1")
    .map((r) => r.id);
  // без учёта регистра, как вся система (etl/lib/dealer_ids.mjs)
  const want = new Set(only.map((d) => d.toLowerCase()));
  const dealers = only.length ? all.filter((d) => want.has(d.toLowerCase())) : all;
  const missing = only.filter((d) => !all.some((a) => a.toLowerCase() === d.toLowerCase()));
  if (missing.length) console.log('!! Нет в daily_statistics: ' + missing.join(', '));
  if (!dealers.length) throw new Error('Список дилеров пуст');

  const built = new Date().toISOString();
  const entries = [];
  const errors = [];
  for (const id of dealers) {
    try {
      const rows = d1Query(snapshotSql(sqlLiteral(id)));
      const { gz, entry } = buildOne(id, rows, built);
      if (gz.length > SNAP_MAX_GZ_BYTES) throw new Error('снимок ' + Math.round(gz.length / 1024) + ' КБ > ' + SNAP_MAX_GZ_BYTES / 1024 + ' КБ');
      const file = path.join(outDir, id + '.json.gz');
      fs.writeFileSync(file, gz);
      if (!noUpload) r2Put(snapKey(id), file, 'application/json');
      entries.push(entry);
      console.log(id.padEnd(36) + String(entry.rows).padStart(7) + ' строк' + String(Math.round(entry.bytes / 1024)).padStart(6) + ' КБ  ' + entry.first + ' — ' + entry.last);
    } catch (e) {
      errors.push(id + ': ' + e.message);
      console.log('!! ' + id + ': ' + e.message);
    }
  }

  // Манифест (список дилеров для владельца) пишется только при полной сборке.
  const manifest = {
    v: 2, built,
    dataTo: entries.reduce((m, e) => (e.last && e.last > m ? e.last : m), ''),
    dealers: entries.slice().sort((a, b) => a.id.localeCompare(b.id))
  };
  const mf = path.join(outDir, '_manifest.json');
  fs.writeFileSync(mf, JSON.stringify(manifest));
  if (!noUpload && !only.length) r2Put(MANIFEST_KEY, mf, 'application/json');

  const kb = Math.round(entries.reduce((s, e) => s + e.bytes, 0) / 1024);
  console.log(`Готово: ${entries.length} снимков, ${kb} КБ, ошибок ${errors.length}, ${Math.round((Date.now() - t0) / 1000)} с` +
    (noUpload ? ' (в R2 не записано)' : '') + (only.length ? ' (частичная сборка — манифест в R2 не менялся)' : '') + ' → ' + outDir);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && /build_snapshots.mjs$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
