#!/usr/bin/env node
// Лёгкая проверка медиаплана после уведомления Google Drive (сайт → mp-watch.yml): читает только листы месяцев дилеров,
// сравнивает со снимком (что изменилось, кто, когда) и обновляет cc_mp_sheets, чтобы админка сразу видела новый лист.
// Пока задание идёт, могут прийти новые уведомления (сайт их не запускает, а помечает pending) — задание проходит ещё раз,
// пока правки не утихнут (не дольше ~6 минут).
// Окружение: DEALERS — Dealer_ID через запятую (пусто — все медиапланы); MONTHS — как в пересчёте недолётов.

import { SHEETS_SCOPE, tokenProvider } from './lib/google.mjs';
import { readSheet } from './lib/sheets.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { buildInserts, sqlLiteral } from './lib/sql.mjs';
import { parseMonthSheet, sheetName } from './lib/mediaplan.mjs';
import { watchRecords } from './lib/mp_watch.mjs';
import { DRIVE_SCOPE, driveInfo, watchSql } from './lib/mp_watch_io.mjs';
import { parseMonths } from './gaps.mjs';

const QUIET_MS = 60000;   // правки утихли: минуту не было уведомлений
const MAX_MS = 6 * 60000; // дольше — догонит следующий запуск или часовой пересчёт
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Один проход: снимки листов месяцев дилеров → журнал и cc_mp_sheets. @returns {number} листов с правками */
export async function checkOnce(token, sheets, months) {
  let changed = 0;
  const sql = [];
  for (const s of sheets) {
    if (!months.includes(s.month)) continue;
    const name = sheetName(s.month);
    let values;
    try { values = await readSheet(token, s.ss, name); } catch (e) { console.log(`⚠️ ${s.dealer} «${name}»: ${e.message}`); continue; }
    let mp;
    try { mp = parseMonthSheet(values); } catch (e) { console.log(`⚠️ ${s.dealer} «${name}»: ${e.message}`); continue; }
    const prev = d1Query(`SELECT cells, totals FROM cc_mp_cells WHERE dealer = ${sqlLiteral(s.dealer)} AND month = ${sqlLiteral(s.month)}`)[0];
    const rec = watchRecords({ dealer: s.dealer, month: s.month, ss: s.ss, sheet: name, values, prev, at: new Date().toISOString() });
    if (rec.log && rec.log.source !== 'first') {
      const info = await driveInfo(token, s.ss);
      Object.assign(rec.log, { modified: info.modified, who: info.who });
      Object.assign(rec.cellsRow, { modified: info.modified, who: info.who });
      changed++;
      console.log(`✏️ ${s.dealer} «${name}»: изменено ячеек ${rec.log.n} (${rec.log.kind})` + (info.who ? ` — ${info.who}` : ''));
      sql.push(`UPDATE cc_mp_sheets SET meta = ${sqlLiteral(JSON.stringify(mp.meta))}, rows = ${sqlLiteral(JSON.stringify(mp.rows))}, error = NULL, ` +
        `checked = ${sqlLiteral(new Date().toISOString())} WHERE dealer = ${sqlLiteral(s.dealer)} AND month = ${sqlLiteral(s.month)};`);
    }
    sql.push(watchSql(rec));
  }
  for (let i = 0; i < sql.length; i += 20) d1ExecFile(sql.slice(i, i + 20).join('\n') + '\n', 'mp-watch');
  return changed;
}

async function main() {
  const started = Date.now();
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-mpcheck';
  d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'], [{ id: runId, kind: 'mp-watch', started: new Date().toISOString(), status: 'running' }]).join('\n'), 'mpc-start');
  const detail = { passes: 0, changed: 0, ghRun: process.env.GITHUB_RUN_ID || undefined };
  let status = 'done';
  try {
    const months = parseMonths(process.env.MONTHS);
    const want = String(process.env.DEALERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const sheets = d1Query(`SELECT dealer, month, ss FROM cc_mp_sheets WHERE month IN (${months.map(sqlLiteral).join(', ')}) AND ss IS NOT NULL`)
      .filter((s) => !want.length || want.includes(String(s.dealer).toLowerCase()));
    if (!sheets.length) throw new Error('Медиапланов этих дилеров нет в базе: ' + (process.env.DEALERS || '(все)'));
    const ssList = [...new Set(sheets.map((s) => s.ss))];
    const token = tokenProvider([SHEETS_SCOPE, DRIVE_SCOPE]);
    for (;;) {
      const passStart = new Date().toISOString();
      detail.passes++;
      detail.changed += await checkOnce(token, sheets, months);
      d1ExecFile(`UPDATE cc_mp_hits SET pending = 0 WHERE ss IN (${ssList.map(sqlLiteral).join(', ')}) AND notified <= ${sqlLiteral(passStart)};\n`, 'mpc-hits');
      if (Date.now() - started > MAX_MS) break;
      // ждём: если за минуту Google сообщил о новой правке — ещё проход
      await sleep(QUIET_MS);
      const late = d1Query(`SELECT COUNT(*) AS n FROM cc_mp_hits WHERE ss IN (${ssList.map(sqlLiteral).join(', ')}) AND notified > ${sqlLiteral(passStart)}`)[0];
      if (!late || !Number(late.n)) break;
    }
    console.log(`Проходов: ${detail.passes}, листов с правками: ${detail.changed}.`);
  } catch (e) {
    status = 'failed';
    detail.error = String(e.message || e).slice(0, 1000);
    console.error('❌ ' + detail.error);
  }
  d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, detail = ${sqlLiteral(JSON.stringify(detail))} WHERE id = ${sqlLiteral(runId)};`, 'mpc-end');
  if (status !== 'done') process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('mp_watch.mjs')) main().catch((e) => { console.error(e); process.exit(1); });
