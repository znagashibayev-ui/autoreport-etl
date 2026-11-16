#!/usr/bin/env node
// Запуск скрипта выгрузки с закрытым журналом.
// Репозиторий публичный (так у GitHub бесплатные безлимитные минуты), а журналы запусков в публичном репозитории
// видит любой человек. Скрипты выгрузки печатают расход и конверсии по дилерам, поэтому здесь весь их вывод
// складывается во временный файл, а в журнал GitHub идёт одна строка: код завершения.
// Подробный журнал сохраняется в базу D1 (таблица etl_logs) — его видите только вы и Claude через Cloudflare.
//
// Использование: node etl/quiet.mjs etl/run_platform.mjs [аргументы]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = process.argv[2];
if (!script || !/^etl\/[a-z_]+\.mjs$/.test(script)) {
  console.error('Укажите скрипт вида etl/имя.mjs');
  process.exit(2);
}
const name = path.basename(script, '.mjs');
const started = new Date().toISOString();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-'));
const summaryFile = path.join(dir, 'summary.md');
fs.writeFileSync(summaryFile, '');

const r = spawnSync(process.execPath, [script, ...process.argv.slice(3)], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 1024,
  env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile }
});
const code = r.status === null ? 1 : r.status;
const summary = fs.readFileSync(summaryFile, 'utf8');
const full = [r.stdout || '', r.stderr || '', r.error ? 'spawn: ' + r.error.message : '', summary ? '\n--- summary ---\n' + summary : ''].join('\n');
const lines = full.split('\n').length;

// Журнал в базу: при ошибке всегда, при успехе — только для основных заданий.
const KEEP_OK = new Set(['run_platform', 'gaps', 'bq_bridge', 'sync_sheets', 'haval_spend', 'google_mcc', 'token_health', 'portal_apply']);
if (process.env.CLOUDFLARE_API_TOKEN && (code !== 0 || KEEP_OK.has(name))) {
  try {
    const { d1ExecFile } = await import('./lib/cloudflare.mjs');
    const { sqlLiteral } = await import('./lib/sql.mjs');
    // лимит D1 — 100 КБ в байтах на выражение (кириллица — 2 байта, «—»/«✔» — 3): режем по байтам
    let tail = full;
    while (Buffer.byteLength(tail) > 80000) tail = tail.slice(-Math.floor(tail.length * 0.9));
    if (tail !== full) tail = '[…начало обрезано…]\n' + tail;
    const ctx = [process.env.PLATFORM, process.env.START, process.env.END, process.env.DEALERS].filter(Boolean).join(' ');
    d1ExecFile([
      'CREATE TABLE IF NOT EXISTS etl_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, name TEXT NOT NULL, ctx TEXT, exit_code INTEGER, gh_run TEXT, log TEXT);',
      `DELETE FROM etl_logs WHERE at < ${sqlLiteral(new Date(Date.now() - 10 * 864e5).toISOString())};`,
      `INSERT INTO etl_logs (at, name, ctx, exit_code, gh_run, log) VALUES (${sqlLiteral(started)}, ${sqlLiteral(name)}, ${sqlLiteral(ctx)}, ${code}, ${sqlLiteral(process.env.GITHUB_RUN_ID || '')}, ${sqlLiteral(tail)});`
    ].join('\n'), 'etl_log');
  } catch (err) {
    console.log('Журнал в базу не записан: ' + String(err.message).split('\n')[0].slice(0, 160));
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${code === 0 ? '✔' : '✖'} ${name}: код ${code}, ${lines} строк журнала скрыты (подробности — в базе, таблица etl_logs).`);
process.exit(code);
