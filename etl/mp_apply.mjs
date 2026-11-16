#!/usr/bin/env node
// «Медиаплан: запись правок»: берёт из D1 очередь cc_mp_changes (её пополняет админка, раздел «Медиапланы»)
// и пишет в лист месяца медиаплана: имя/инструмент/цель новой кампании и доли «% от бюджета». Остальное таблица считает сама.
// В очереди лежит сам план (кампании и дневные бюджеты): ячейки считаются по листу, каким он стал к моменту записи.
// Нет свободной пары строк «План/Факт» у площадки — скрипт вставляет её сам (копия последней пары площадки с формулами).
// После записи перечитывает лист, сверяет дневные бюджеты и сохраняет в cc_mp_sheets, чтобы админка сразу показала новые цифры.
// Доступ: GCP_WIF_PROVIDER + GCP_SERVICE_ACCOUNT (роль «Редактор» в медиаплане), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (D1).

import { tokenProvider } from './lib/google.mjs';
import { readSheet } from './lib/sheets.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { buildInserts, sqlLiteral } from './lib/sql.mjs';
import { runProgress } from './lib/progress.mjs';

const STEPS = {
  read: [0, 25, 'Читаем лист месяца медиаплана'],
  insert: [25, 45, 'Вставляем пары строк «План/Факт»'],
  write: [45, 75, 'Пишем доли «% от бюджета» и новые кампании'],
  verify: [75, 100, 'Перечитываем лист и сверяем дневные бюджеты']
};
import { deletePlan, insertRequests, mergeChanges, nameKey, parseMonthSheet, planToOps, rebalanceOps, rollbackOps } from './lib/mediaplan.mjs';
import { labelsOf, totalsOf } from './lib/mp_watch.mjs';
import { watchRecords } from './lib/mp_watch.mjs';
import { watchSql } from './lib/mp_watch_io.mjs';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const SA = 'autoreport-github@astana-motors-accounts.iam.gserviceaccount.com';
const q = (name) => "'" + name.replace(/'/g, "''") + "'";

/** Проверка перед записью: в столбце «Кампания» каждой затрагиваемой строки — ожидаемое имя (или пусто для новой). */
export function checkExpect(values, ops, nameCol) {
  const ci = nameCol.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const bad = [];
  for (const o of ops) {
    if (o.expect === undefined) continue;
    const got = String(((values[o.row - 1] || [])[ci]) ?? '').trim().toLowerCase();
    if (got !== String(o.expect).trim().toLowerCase()) bad.push(`строка ${o.row}: ожидалась «${o.expect || 'пусто'}», в листе «${got || 'пусто'}»`);
  }
  return [...new Set(bad)];
}

export async function api(token, ss, path, body) {
  const res = await fetch(SHEETS_API + ss + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(res.status === 403 ? `Нет права записи в медиаплан: откройте таблицу ${SA} с ролью «Редактор»`
      : 'Google Sheets: ' + ((out.error && out.error.message) || 'HTTP ' + res.status));
  }
  return out;
}

async function sheetIdOf(token, ss, title) {
  const res = await fetch(SHEETS_API + ss + '?fields=sheets.properties(sheetId,title)', { headers: { Authorization: 'Bearer ' + (await token()) } });
  const out = await res.json().catch(() => ({}));
  const s = (out.sheets || []).find((x) => x.properties.title === title);
  if (!s) throw new Error(`В таблице нет листа «${title}»`);
  return s.properties.sheetId;
}

/** Снимок листа → журнал контроля медиаплана (cc_mp_log). Ошибка журнала не мешает записи. */
export function logWatch(ch, values, source, who) {
  try {
    const prev = d1Query(`SELECT cells, totals FROM cc_mp_cells WHERE dealer = ${sqlLiteral(ch.dealer)} AND month = ${sqlLiteral(ch.month)}`)[0];
    const rec = watchRecords({ dealer: ch.dealer, month: ch.month, ss: ch.ss, sheet: ch.sheet, values, prev, at: new Date().toISOString(),
      source, who: who || (source === 'admin' ? 'Админка (Центр управления)' : null) });
    d1ExecFile(watchSql(rec) + '\n', 'mp-watch');
  } catch (e) {
    console.log('⚠️ Журнал медиаплана не записан: ' + e.message);
  }
}

/** Лист в виде формул (для отката: формулы не перезаписываются). */
async function readFormulas(token, ss, sheet) {
  const url = SHEETS_API + ss + '/values/' + encodeURIComponent(q(sheet)) + '?valueRenderOption=FORMULA&majorDimension=ROWS';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + (await token()) } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google Sheets: ' + ((out.error && out.error.message) || 'HTTP ' + res.status));
  return out.values || [];
}

/** Удаление кампании: пара строк «План/Факт» (или очистка последней кампании площадки) и доли остальных → 100%. */
async function applyDelete(token, ch, op, prog) {
  prog.phase('read', ch.dealer);
  const before = await readSheet(token, ch.ss, ch.sheet);
  logWatch(ch, before, 'table');
  const mp0 = parseMonthSheet(before);
  const lines = [];
  for (const t of op.rows) {
    const cur = parseMonthSheet(await readSheet(token, ch.ss, ch.sheet));
    const del = deletePlan(cur, t);
    prog.phase('write', del.name);
    if (del.mode === 'delete') {
      const sheetId = await sheetIdOf(token, ch.ss, ch.sheet);
      await api(token, ch.ss, ':batchUpdate', { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: del.start, endIndex: del.end } } }] });
      lines.push(`− ${del.d1}: ${del.name} — удалена (строки ${del.start + 1}–${del.end}${del.share > 0 ? `, её доля ${Math.round(del.share * 1000) / 10}% роздана остальным кампаниям площадки` : ''})`);
    } else {
      await api(token, ch.ss, '/values:batchClear', { ranges: del.clear.map((c) => q(ch.sheet) + '!' + c) });
      lines.push(`− ${del.d1}: ${del.name} — последняя кампания площадки, строки оставлены пустыми (бюджет площадки не распределён)`);
    }
    const after = parseMonthSheet(await readSheet(token, ch.ss, ch.sheet));
    const ops = rebalanceOps(after, del.d1);
    if (ops.length) await api(token, ch.ss, '/values:batchUpdate', { valueInputOption: 'RAW', data: ops.map((o) => ({ range: q(ch.sheet) + '!' + o.col + o.row, values: [[o.value]] })) });
  }
  prog.phase('verify');
  const fin = await readSheet(token, ch.ss, ch.sheet);
  logWatch(ch, fin, 'admin');
  const mp = parseMonthSheet(fin);
  saveSheet(ch, mp);
  // бюджет площадок не должен измениться (кроме очищенной последней кампании)
  // по площадке целиком (totalsOf складывает блоки с одним названием), а не по первому блоку с таким именем
  const after = Object.fromEntries(totalsOf(mp.meta).platforms.map((x) => [x.p, x.planGross]));
  const moved = totalsOf(mp0.meta).platforms.filter((p) => p.p in after && Math.abs((after[p.p] || 0) - (p.planGross || 0)) >= 1);
  if (moved.length) throw new Error('Удалено, но бюджет площадки изменился: ' + moved.map((p) => p.p).join(', ') + ' — проверьте лист «' + ch.sheet + '»');
  return `Удалено в «${ch.sheet}»: ${lines.join('; ')}`;
}

/** «Вернуть как было»: старые значения ячеек записи журнала (без формул и факта, без ячеек, которые меняли позже). */
async function applyRollback(token, ch, op, prog) {
  prog.phase('read', ch.dealer);
  // одна запись журнала или все правки плана после момента op.since (сводятся по ячейкам: «было» — до первой)
  const where = op.since ? `at > ${sqlLiteral(op.since)} AND kind IN ('plan', 'mixed')` : `id = ${Number(op.log)}`;
  const list = d1Query(`SELECT id, at, changes FROM cc_mp_log WHERE ${where} AND dealer = ${sqlLiteral(ch.dealer)} AND month = ${sqlLiteral(ch.month)} ORDER BY id`);
  if (!list.length) throw new Error(op.since ? 'После этого момента план не менялся' : 'Записи журнала нет');
  const entry = { at: op.since || list[0].at, changes: JSON.stringify(mergeChanges(list.map((e) => ({ changes: JSON.parse(e.changes || '[]') })))) };
  const values = await readSheet(token, ch.ss, ch.sheet);
  logWatch(ch, values, 'table');
  const formulas = await readFormulas(token, ch.ss, ch.sheet);
  const mp0 = parseMonthSheet(values);
  const { writes, skipped } = rollbackOps(JSON.parse(entry.changes || '[]'), values, formulas, labelsOf(values, mp0));
  if (!writes.length) {
    throw new Error('Вернуть нечего: ' + [skipped.later && `изменены позже — ${skipped.later}`, skipped.moved && `строки сдвинулись — ${skipped.moved}`,
      skipped.formula && `формулы (пересчитаются сами) — ${skipped.formula}`].filter(Boolean).join(', '));
  }
  prog.phase('write', writes.length + ' ячеек');
  await api(token, ch.ss, '/values:batchUpdate', { valueInputOption: 'RAW', data: writes.map((w) => ({ range: q(ch.sheet) + '!' + w.a1, values: [[w.value]] })) });
  prog.phase('verify');
  const fin = await readSheet(token, ch.ss, ch.sheet);
  logWatch(ch, fin, 'admin');
  saveSheet(ch, parseMonthSheet(fin));
  const skip = [skipped.formula && `формулы ${skipped.formula} (пересчитались сами)`, skipped.later && `изменённые позже ${skipped.later}`, skipped.moved && `сдвинутые строки ${skipped.moved}`].filter(Boolean);
  return `Возвращено как было (${op.since ? 'состояние на ' : 'запись журнала от '}${new Date(Date.parse(entry.at) + 5 * 3600000).toISOString().slice(0, 16).replace('T', ' ')} по Алматы): ячеек ${writes.length} — ${writes.slice(0, 8).map((w) => w.a1 + ' ' + w.from + ' → ' + w.value).join(', ')}${writes.length > 8 ? ' …' : ''}` +
    (skip.length ? '. Не тронуты: ' + skip.join(', ') : '');
}

export function saveSheet(ch, mp) {
  d1ExecFile(`UPDATE cc_mp_sheets SET meta = ${sqlLiteral(JSON.stringify(mp.meta))}, rows = ${sqlLiteral(JSON.stringify(mp.rows))}, ` +
    `error = NULL, checked = ${sqlLiteral(new Date().toISOString())} WHERE dealer = ${sqlLiteral(ch.dealer)} AND month = ${sqlLiteral(ch.month)};`, 'mp-sheet');
}

async function applyOne(token, ch, prog) {
  const op = JSON.parse(ch.ops);
  if (op.type === 'delete') return applyDelete(token, ch, op, prog);
  if (op.type === 'rollback') return applyRollback(token, ch, op, prog);
  const { plan, scope, allowOver } = op;
  prog.phase('read', ch.dealer);
  prog.source(`Медиаплан ${ch.dealer} → лист «${ch.sheet}» (таблица ${ch.ss.slice(0, 8)}…)`, true);
  const before = await readSheet(token, ch.ss, ch.sheet);
  // правки в таблице, сделанные руками до этой записи, — в журнал как «таблица», чтобы не приписать их админке
  logWatch(ch, before, 'table');
  let mp0 = parseMonthSheet(before);
  const pre = planToOps(mp0, plan, scope, { insert: true, allowOver });
  let added = 0;
  if (Object.keys(pre.inserts).length) {
    prog.phase('insert', Object.entries(pre.inserts).map(([p, n]) => p + ' +' + n).join(', '));
    const sheetId = await sheetIdOf(token, ch.ss, ch.sheet);
    const { requests, clear } = insertRequests(mp0, pre.inserts, sheetId);
    await api(token, ch.ss, ':batchUpdate', { requests });
    await api(token, ch.ss, '/values:batchClear', { ranges: clear.map((c) => q(ch.sheet) + '!' + c) });
    added = Object.values(pre.inserts).reduce((s, n) => s + n, 0);
    mp0 = parseMonthSheet(await readSheet(token, ch.ss, ch.sheet));
  }
  const { ops } = planToOps(mp0, plan, scope, { allowOver });
  prog.phase('write', ops.length + ' ячеек');
  prog.source(`«${ch.sheet}» → ${[...new Set(ops.map((o) => o.col + o.row))].slice(0, 12).join(', ')}${ops.length > 12 ? ' …' : ''}`, true);
  prog.rows(ops.length);
  await api(token, ch.ss, '/values:batchUpdate', { valueInputOption: 'RAW', data: ops.map((o) => ({ range: q(ch.sheet) + '!' + o.col + o.row, values: [[o.value]] })) });
  prog.phase('verify');
  const after = await readSheet(token, ch.ss, ch.sheet);
  logWatch(ch, after, 'admin');
  const mp = parseMonthSheet(after);
  d1ExecFile(`UPDATE cc_mp_sheets SET meta = ${sqlLiteral(JSON.stringify(mp.meta))}, rows = ${sqlLiteral(JSON.stringify(mp.rows))}, ` +
    `error = NULL, checked = ${sqlLiteral(new Date().toISOString())} WHERE dealer = ${sqlLiteral(ch.dealer)} AND month = ${sqlLiteral(ch.month)};`, 'mp-sheet');
  // проверка: дневные бюджеты, пересчитанные формулами таблицы, = запрошенным
  // одно имя в листе дважды (дубль, сделанный раньше) — сверяется сумма по всем его строкам
  const off = plan.filter((c) => {
    const same = mp.rows.filter((x) => nameKey(x.name) === nameKey(c.rename || c.name)); // после переименования строка — под новым именем
    return !same.length || Math.abs(same.reduce((s, x) => s + x.daily, 0) - c.daily) > 0.05;
  });
  if (off.length) throw new Error(`Записано, но дневной бюджет в таблице не совпал у: ${off.map((c) => c.name).join(', ')} — проверьте лист «${ch.sheet}»`);
  return `Записано в «${ch.sheet}»: ${ops.length} ячеек${added ? `, добавлено пар строк «План/Факт»: ${added}` : ''}. ` + JSON.parse(ch.summary).join('; ');
}

async function main() {
  const pending = d1Query("SELECT * FROM cc_mp_changes WHERE status = 'pending' ORDER BY id");
  if (!pending.length) { console.log('Правок в очереди нет.'); return; }
  const token = tokenProvider(['https://www.googleapis.com/auth/spreadsheets']);
  let failed = 0;
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-mp';
  d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'], [{ id: runId, kind: 'mp', started: new Date().toISOString(), status: 'running' }]).join('\n'), 'mp-start');
  const prog = runProgress(runId, STEPS);
  for (const ch of pending) {
    let status = 'done'; let message;
    try {
      message = await applyOne(token, ch, prog);
    } catch (e) {
      status = 'failed'; failed++;
      message = String(e.message || e).slice(0, 1500);
    }
    console.log(`${ch.dealer} ${ch.month}: ${status === 'done' ? '✅' : '❌'} ${message}`);
    d1ExecFile(`UPDATE cc_mp_changes SET status = ${sqlLiteral(status)}, message = ${sqlLiteral(message)}, done_at = ${sqlLiteral(new Date().toISOString())}, ` +
      `gh_run = ${sqlLiteral(process.env.GITHUB_RUN_ID || null)} ` +
      `WHERE id = ${Number(ch.id)};`, 'mp-change');
  }
  d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(failed ? 'failed' : 'done')}, ` +
    `detail = ${sqlLiteral(JSON.stringify({ changes: pending.length, failed }))} WHERE id = ${sqlLiteral(runId)};`, 'mp-end');
  if (failed) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('mp_apply.mjs')) main().catch((e) => { console.error(e); process.exit(1); });
