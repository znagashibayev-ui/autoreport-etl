#!/usr/bin/env node
// Перенос истории из BigQuery (marketing_data) в Cloudflare: daily_statistics и доступы → D1,
// segments_statistics → R2 (Parquet по месяцам). BigQuery только читается.
//
// Режимы (MODE / --mode):
//   inventory — опись: таблицы датасета, строки, размер, даты; ничего не пишет (по умолчанию)
//   daily     — daily_statistics → D1, помесячно (DELETE месяца + INSERT), со сверкой каждого месяца
//   access    — dealer_email_access → D1 (полная замена)
//   segments  — segments_statistics → R2 Parquet, со сверкой каждого месяца
//   verify    — сверка daily_statistics BigQuery ↔ D1 по всем месяцам, без записи данных
//   all       — daily → access → segments одним запуском
//
// Месяцы (MONTHS / --months): all | 2026-09 | 2026-01..2026-06. По умолчанию all.
// Доступ к Google: GCP_WIF_PROVIDER + GCP_SERVICE_ACCOUNT (вход без ключа из GitHub Actions) или GCP_SA_KEY.
// Cloudflare: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BQ_SCOPE, bqListTables, bqSelect, bqStream, tokenProvider } from './lib/google.mjs';
import { buildInserts, buildReplaceFile, monthRange, monthsBetween, sqlLiteral } from './lib/sql.mjs';
import { d1ExecFile, d1Query, r2Put } from './lib/cloudflare.mjs';
import { compareAggregates } from './lib/compare.mjs';

const PROJECT = 'astana-motors-accounts';
const DATASET = 'marketing_data';
const LOCATION = 'EU';
const T = (name) => `\`${PROJECT}.${DATASET}.${name}\``;

export const DAILY_COLUMNS = ['Date', 'Platform', 'Dealer_ID', 'Dealer_Type', 'Campaign_Name', 'Impressions', 'Reach',
  'Clicks', 'Conversions', 'Spend_KZT', 'Spend_USD', 'Marketing_Objective', 'Campaign_Type', 'Car_Brand', 'Car_Model'];

const DUCK_TYPES = { STRING: 'VARCHAR', INTEGER: 'BIGINT', INT64: 'BIGINT', FLOAT: 'DOUBLE', FLOAT64: 'DOUBLE',
  NUMERIC: 'DOUBLE', DATE: 'DATE', BOOLEAN: 'BOOLEAN', BOOL: 'BOOLEAN', TIMESTAMP: 'TIMESTAMP', DATETIME: 'TIMESTAMP' };

/* ---------- параметры ---------- */

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[name.toUpperCase()] || fallback;
}

const MODE = arg('mode', 'inventory');
const MONTHS = arg('months', 'all');
const RUN_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + MODE;
const summary = [];

function say(line) {
  console.log(line);
  summary.push(line);
}

function writeSummary() {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
}

// Токен Google обновляется сам каждые 50 минут — долгие переносы не обрываются на часе.
const googleToken = tokenProvider([BQ_SCOPE]);

async function select(_tok, sql) {
  return bqSelect(await googleToken(), { project: PROJECT, location: LOCATION, sql });
}

async function monthList(tok, table) {
  const { rows } = await select(tok, `SELECT FORMAT_DATE('%Y-%m', MIN(Date)) AS a, FORMAT_DATE('%Y-%m', MAX(Date)) AS b FROM ${T(table)}`);
  const all = rows[0] && rows[0].a ? monthsBetween(rows[0].a, rows[0].b) : [];
  if (MONTHS === 'all') return all;
  const m = /^(\d{4}-\d{2})(?:\.\.(\d{4}-\d{2}))?$/.exec(MONTHS);
  if (!m) throw new Error('MONTHS: ожидается all | 2026-09 | 2026-01..2026-06, получено ' + MONTHS);
  return monthsBetween(m[1], m[2] || m[1]);
}

/* ---------- inventory ---------- */

async function inventory(tok) {
  say('## Опись BigQuery `' + PROJECT + '.' + DATASET + '`');
  const tables = await bqListTables(await googleToken(), { project: PROJECT, dataset: DATASET });
  say('| Таблица | Тип | Строк | МБ | Партиция | Колонок |');
  say('|---|---|---:|---:|---|---:|');
  for (const t of tables.sort((a, b) => b.bytes - a.bytes)) {
    say(`| ${t.table} | ${t.type} | ${t.rows.toLocaleString('ru-RU')} | ${(t.bytes / 1048576).toFixed(1)} | ${t.partitioned} | ${t.columns.length} |`);
  }
  for (const name of ['daily_statistics', 'segments_statistics']) {
    if (!tables.some((t) => t.table === name)) continue;
    const { rows, bytes } = await select(tok,
      `SELECT FORMAT_DATE('%Y-%m', Date) AS month, COUNT(*) AS n, ROUND(SUM(Spend_KZT)) AS spend FROM ${T(name)} GROUP BY month ORDER BY month`);
    say(`\n### ${name} по месяцам (прочитано ${(bytes / 1048576).toFixed(1)} МБ)`);
    say('| Месяц | Строк | Расход ₸ |');
    say('|---|---:|---:|');
    for (const r of rows) say(`| ${r.month} | ${r.n.toLocaleString('ru-RU')} | ${Math.round(r.spend).toLocaleString('ru-RU')} |`);
  }
  return { tables: tables.length };
}

/* ---------- daily_statistics → D1 ---------- */

const DAILY_AGG = (where) =>
  `SELECT Dealer_ID, Platform, COUNT(*) AS n, ROUND(SUM(Spend_KZT), 2) AS spend, SUM(Conversions) AS conv ` +
  `FROM daily_statistics WHERE ${where} GROUP BY Dealer_ID, Platform`;

async function bqDailyAgg(tok, month) {
  const { from, to } = monthRange(month);
  const { rows } = await select(tok,
    `SELECT Dealer_ID, Platform, COUNT(*) AS n, ROUND(SUM(Spend_KZT), 2) AS spend, SUM(Conversions) AS conv ` +
    `FROM ${T('daily_statistics')} WHERE Date BETWEEN '${from}' AND '${to}' GROUP BY Dealer_ID, Platform`);
  return rows;
}

function d1DailyAgg(month) {
  const { from, to } = monthRange(month);
  return d1Query(DAILY_AGG(`Date BETWEEN '${from}' AND '${to}'`));
}

async function daily(tok, { write }) {
  const months = await monthList(tok, 'daily_statistics');
  say(`## daily_statistics → D1 (${write ? 'перенос' : 'только сверка'}), месяцев: ${months.length}`);
  say('| Месяц | Строк BigQuery | Строк D1 | Расход ₸ | Сверка |');
  say('|---|---:|---:|---:|---|');
  const checks = [];
  let bad = 0;
  for (const month of months) {
    const { from, to } = monthRange(month);
    if (write) {
      const cols = DAILY_COLUMNS.map((c) => (c === 'Date' ? 'CAST(Date AS STRING) AS Date' : c)).join(', ');
      const { rows } = await select(tok, `SELECT ${cols} FROM ${T('daily_statistics')} WHERE Date BETWEEN '${from}' AND '${to}' ORDER BY Date, Dealer_ID, Platform`);
      d1ExecFile(buildReplaceFile({ table: 'daily_statistics', columns: DAILY_COLUMNS, rows,
        where: `Date BETWEEN ${sqlLiteral(from)} AND ${sqlLiteral(to)}` }), 'daily-' + month);
    }
    const cmp = compareAggregates(await bqDailyAgg(tok, month), d1DailyAgg(month));
    if (!cmp.ok) bad++;
    cmp.rows.forEach((r) => checks.push({ ...r, month }));
    say(`| ${month} | ${cmp.totals.bq.n.toLocaleString('ru-RU')} | ${cmp.totals.other.n.toLocaleString('ru-RU')} | ` +
      `${Math.round(cmp.totals.bq.spend).toLocaleString('ru-RU')} | ${cmp.ok ? '✅ 1:1' : '❌ ' + cmp.diffs + ' расхождений'} |`);
  }
  saveChecks('daily_statistics', checks);
  say(bad ? `\n❌ Расхождения в ${bad} мес. — подробности в D1, таблица migration_check, run_id = ${RUN_ID}` : '\n✅ Все месяцы совпали с BigQuery 1:1.');
  return { months: months.length, bad };
}

function saveChecks(tbl, checks) {
  const cols = ['run_id', 'tbl', 'month', 'Dealer_ID', 'Platform', 'bq_rows', 'new_rows', 'bq_spend_kzt', 'new_spend_kzt', 'bq_conversions', 'new_conversions', 'ok'];
  const rows = checks.map((c) => ({ run_id: RUN_ID, tbl, month: c.month, Dealer_ID: c.Dealer_ID, Platform: c.Platform,
    bq_rows: c.bq.n, new_rows: c.other.n, bq_spend_kzt: c.bq.spend, new_spend_kzt: c.other.spend,
    bq_conversions: c.bq.conv, new_conversions: c.other.conv, ok: c.ok ? 1 : 0 }));
  if (rows.length) d1ExecFile(buildInserts('migration_check', cols, rows).join('\n'), 'checks');
}

/* ---------- dealer_email_access → D1 ---------- */

async function access(tok) {
  const { rows } = await select(tok, `SELECT Email, Distr_Dealer_ID FROM ${T('dealer_email_access')} ORDER BY Email`);
  d1ExecFile(buildReplaceFile({ table: 'dealer_email_access', columns: ['Email', 'Distr_Dealer_ID'], rows, where: '1=1' }), 'access');
  const [{ n }] = d1Query('SELECT COUNT(*) AS n FROM dealer_email_access');
  const ok = n === rows.length;
  say(`## dealer_email_access → D1: BigQuery ${rows.length}, D1 ${n} — ${ok ? '✅ совпало' : '❌ не совпало'}`);
  return { rows: rows.length, bad: ok ? 0 : 1 };
}

/* ---------- segments_statistics → R2 Parquet ---------- */

function duck(sql) {
  const bin = process.env.DUCKDB_BIN || 'duckdb';
  const r = spawnSync(bin, ['-json', '-c', sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('DuckDB: ' + (r.stderr || r.stdout).slice(-1500));
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : [];
}

/**
 * Месяц разрезов из BigQuery прямо в NDJSON-файл: в памяти держится только одна страница
 * (20 000 строк), поэтому размер месяца не ограничен памятью.
 * @returns {Promise<{schema: object[], total: number}>}
 */
export async function streamToNdjson(sql, file, { stream = bqStream, token = googleToken } = {}) {
  const fd = fs.openSync(file, 'w');
  try {
    return await stream(token, { project: PROJECT, location: LOCATION, sql }, (chunk) => {
      fs.writeSync(fd, chunk.map((r) => JSON.stringify(r)).join('\n') + '\n');
    });
  } finally {
    fs.closeSync(fd);
  }
}

/** Месяцы, уже перенесённые и сверенные (таблица migration_done) — при повторном запуске пропускаются. */
function doneMonths(tbl) {
  return new Set(d1Query(`SELECT month FROM migration_done WHERE tbl = ${sqlLiteral(tbl)}`).map((r) => r.month));
}

function markDone(tbl, month, rows, spend) {
  d1ExecFile(`DELETE FROM migration_done WHERE tbl = ${sqlLiteral(tbl)} AND month = ${sqlLiteral(month)};\n` +
    buildInserts('migration_done', ['tbl', 'month', 'rows', 'spend_kzt', 'run_id', 'finished'],
      [{ tbl, month, rows, spend_kzt: spend, run_id: RUN_ID, finished: new Date().toISOString() }]).join('\n'), 'done-' + month);
}

async function segments(tok) {
  const months = await monthList(tok, 'segments_statistics');
  // Явно указанные месяцы переносятся заново; при MONTHS=all уже готовые пропускаются (продолжение после сбоя).
  const skip = MONTHS === 'all' && process.env.FORCE !== '1' ? doneMonths('segments_statistics') : new Set();
  say(`## segments_statistics → R2 (Parquet), месяцев: ${months.length}` + (skip.size ? `, уже готово ранее: ${skip.size}` : ''));
  say('| Месяц | Строк | МБ Parquet | Сверка |');
  say('|---|---:|---:|---|');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-'));
  let bad = 0;
  try {
    for (const month of months) {
      if (skip.has(month)) { say(`| ${month} | — | — | ✅ уже перенесено ранее |`); continue; }
      const { from, to } = monthRange(month);
      const json = path.join(dir, month + '.ndjson');
      const { schema, total } = await streamToNdjson(`SELECT * FROM ${T('segments_statistics')} WHERE Date BETWEEN '${from}' AND '${to}'`, json);
      const rows = { length: total };
      const cols = '{' + schema.map((f) => `'${f.name}': '${DUCK_TYPES[f.type] || 'VARCHAR'}'`).join(', ') + '}';
      const pq = path.join(dir, month + '.parquet').replace(/\\/g, '/');
      const src = json.replace(/\\/g, '/');
      duck(`COPY (SELECT * FROM read_json('${src}', format='newline_delimited', columns=${cols})) TO '${pq}' (FORMAT parquet, COMPRESSION zstd)`);
      const pqAgg = duck(`SELECT Dealer_ID, Platform, Breakdown_Type, COUNT(*) AS n, ROUND(SUM(Spend_KZT), 2) AS spend, SUM(Conversions) AS conv ` +
        `FROM read_parquet('${pq}') GROUP BY ALL`);
      const { rows: bqAgg } = await select(tok,
        `SELECT Dealer_ID, Platform, Breakdown_Type, COUNT(*) AS n, ROUND(SUM(Spend_KZT), 2) AS spend, SUM(Conversions) AS conv ` +
        `FROM ${T('segments_statistics')} WHERE Date BETWEEN '${from}' AND '${to}' GROUP BY Dealer_ID, Platform, Breakdown_Type`);
      const cmp = compareAggregates(bqAgg, pqAgg, ['Dealer_ID', 'Platform', 'Breakdown_Type']);
      // проверки сохраняются сразу по месяцу: если запуск оборвётся, сделанное не потеряется
      saveChecks('segments_statistics', cmp.rows.map((r) => ({ ...r, month, Platform: r.Platform + ' / ' + r.Breakdown_Type })));
      if (cmp.ok) {
        r2Put(`segments_statistics/month=${month}/data.parquet`, pq);
        markDone('segments_statistics', month, cmp.totals.bq.n, cmp.totals.bq.spend);
      } else {
        bad++;
      }
      say(`| ${month} | ${rows.length.toLocaleString('ru-RU')} | ${(fs.statSync(pq).size / 1048576).toFixed(1)} | ` +
        `${cmp.ok ? '✅ 1:1, загружено в R2' : '❌ ' + cmp.diffs + ' расхождений — в R2 не загружено'} |`);
      fs.rmSync(json);
      fs.rmSync(pq);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { months: months.length, bad };
}

/* ---------- запуск ---------- */

async function main() {
  const startedAt = new Date().toISOString();
  say(`# Перенос BigQuery → Cloudflare: режим «${MODE}», месяцы: ${MONTHS}`);
  let tok = null;
  if (MODE !== 'inventory') {
    d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'],
      [{ id: RUN_ID, kind: MODE, started: startedAt, status: 'running' }]).join('\n'), 'run-start');
  }
  let result;
  let status = 'done';
  try {
    tok = await googleToken(); // ошибка входа в Google попадёт в итог запуска, а не только в журнал
    if (MODE === 'inventory') result = await inventory(tok);
    else if (MODE === 'daily') result = await daily(tok, { write: true });
    else if (MODE === 'verify') result = await daily(tok, { write: false });
    else if (MODE === 'access') result = await access(tok);
    else if (MODE === 'segments') result = await segments(tok);
    else if (MODE === 'all') {
      const parts = { daily: await daily(tok, { write: true }) };
      parts.access = await access(tok);
      parts.segments = await segments(tok);
      result = { ...parts, bad: parts.daily.bad + parts.access.bad + parts.segments.bad };
      say(result.bad ? '\n## ❌ Есть расхождения — см. таблицы выше' : '\n## ✅ Перенос завершён: всё совпало с BigQuery 1:1');
    } else throw new Error('Неизвестный режим: ' + MODE);
    if (result && result.bad) status = 'failed';
  } catch (err) {
    status = 'failed';
    say('\n❌ Ошибка: ' + err.message);
    result = { error: err.message };
  } finally {
    if (MODE !== 'inventory') {
      try {
        d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, ` +
          `detail = ${sqlLiteral(JSON.stringify(result || {}))} WHERE id = ${sqlLiteral(RUN_ID)};`, 'run-end');
      } catch (e) {
        say('⚠️ Не удалось записать итог в etl_runs: ' + e.message);
      }
    }
    writeSummary();
  }
  if (status !== 'done') process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('migrate_bq.mjs')) main();
