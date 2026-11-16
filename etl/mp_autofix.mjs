#!/usr/bin/env node
// Автовыравнивание плана «Общий бюджет» (S) медиапланов. Запускается после каждого снимка листа (пересчёт недолётов, правка в таблице).
// Если S площадки ушёл от утверждённого, потому что доли кампаний площадки перестали давать 100%, разница раздаётся кампаниям,
// которые руками не правили (пропорционально их долям) — S площадки снова равен утверждённому. Что, сколько и куда — уведомление
// в админке (cc_mp_notices), висит до «Подтвердить». Если выровнять нельзя (менялись бюджет площадки, курс, дни) — тоже уведомление.
// Окружение: DEALERS — только эти Dealer_ID (пусто — все), MONTHS — как в пересчёте недолётов.

import { tokenProvider } from './lib/google.mjs';
import { readSheet } from './lib/sheets.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { buildInserts, sqlLiteral } from './lib/sql.mjs';
import { autoFixOps, parseMonthSheet, sheetName } from './lib/mediaplan.mjs';
import { deviations, totalsOf } from './lib/mp_watch.mjs';
import { api, checkExpect, logWatch, saveSheet } from './mp_apply.mjs';
import { parseMonths } from './gaps.mjs';

const q = (name) => "'" + name.replace(/'/g, "''") + "'";
const WHO = 'Автовыравнивание плана';

/** Кампании, чью долю «% от бюджета» правили в таблице после утверждения плана: их не трогаем. */
export function lockedNames(logRows) {
  const out = new Set();
  for (const l of logRows) {
    for (const c of JSON.parse(l.changes || '[]')) {
      if (c.col !== '% от бюджета' || !/ · План$/.test(c.row) || / · итог · /.test(c.row)) continue;
      out.add(c.row.replace(/ · План$/, ''));
    }
  }
  return [...out];
}

async function fixOne(token, s, base, logs) {
  const values = await readSheet(token, s.ss, s.sheet);
  const mp = parseMonthSheet(values);
  const devs = deviations(totalsOf(mp.meta), base).filter((x) => x.p);
  if (!devs.length) return null; // снимок устарел, в живом листе уже всё сходится
  const locked = lockedNames(logs);
  const detail = [];
  const ops = [];
  for (const dv of devs) {
    const r = autoFixOps(mp, dv.p, locked);
    detail.push({ p: dv.p, base: dv.base, before: dv.now, locked: locked.filter((n) => mp.rows.some((x) => x.d1 === dv.p && x.name === n)), moves: r.moves, reason: r.reason || '' });
    ops.push(...r.ops);
  }
  if (ops.length) {
    const bad = checkExpect(values, ops, mp.meta.cols.name);
    if (bad.length) throw new Error('Лист сдвинулся, выравнивание не записано: ' + bad.slice(0, 3).join('; '));
    await api(token, s.ss, '/values:batchUpdate', { valueInputOption: 'RAW', data: ops.map((o) => ({ range: q(s.sheet) + '!' + o.col + o.row, values: [[o.value]] })) });
    const ch = { dealer: s.dealer, month: s.month, ss: s.ss, sheet: s.sheet };
    const after = await readSheet(token, s.ss, s.sheet);
    logWatch(ch, after, 'admin', WHO);
    const mp2 = parseMonthSheet(after);
    saveSheet(ch, mp2);
    const t2 = totalsOf(mp2.meta);
    for (const d of detail) d.after = (t2.platforms.find((x) => x.p === d.p) || {}).plan ?? null;
  }
  return { detail, applied: ops.length > 0 };
}

async function main() {
  const months = parseMonths(process.env.MONTHS);
  const want = String(process.env.DEALERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  let sheets;
  try {
    sheets = d1Query(`SELECT c.dealer, c.month, c.totals, s.ss, s.sheet FROM cc_mp_cells c JOIN cc_mp_sheets s ON s.dealer = c.dealer AND s.month = c.month ` +
      `WHERE c.month IN (${months.map(sqlLiteral).join(', ')}) AND s.error IS NULL`).filter((s) => !want.length || want.includes(String(s.dealer).toLowerCase()));
  } catch (e) {
    console.log('Контроль медиапланов ещё не включён: ' + e.message);
    return;
  }
  const base = d1Query(`SELECT dealer, month, platform, plan, set_at FROM cc_mp_baseline WHERE month IN (${months.map(sqlLiteral).join(', ')})`);
  const todo = sheets.filter((s) => deviations(JSON.parse(s.totals || 'null'), base.filter((b) => b.dealer === s.dealer && b.month === s.month)).some((x) => x.p));
  if (!todo.length) { console.log('Отклонений от утверждённого плана нет — выравнивать нечего.'); return; }
  const token = tokenProvider(['https://www.googleapis.com/auth/spreadsheets']);
  const notices = [];
  for (const s of todo) {
    s.sheet = s.sheet || sheetName(s.month);
    const b = base.filter((x) => x.dealer === s.dealer && x.month === s.month);
    const since = b.reduce((m, x) => (x.set_at > m ? x.set_at : m), '');
    const logs = d1Query(`SELECT changes FROM cc_mp_log WHERE dealer = ${sqlLiteral(s.dealer)} AND month = ${sqlLiteral(s.month)} AND source = 'table' AND at > ${sqlLiteral(since)}`);
    try {
      const r = await fixOne(token, s, b, logs);
      if (!r) continue;
      const open = d1Query(`SELECT detail FROM cc_mp_notices WHERE dealer = ${sqlLiteral(s.dealer)} AND month = ${sqlLiteral(s.month)} AND kind = 'autofix_failed' AND confirmed_at IS NULL`);
      // «не получилось» — одно открытое уведомление на медиаплан, а не новое каждый час
      if (!r.applied && open.some((o) => o.detail === JSON.stringify(r.detail))) continue;
      notices.push({ dealer: s.dealer, month: s.month, at: new Date().toISOString(), kind: r.applied ? 'autofix' : 'autofix_failed', detail: JSON.stringify(r.detail) });
      console.log(`${r.applied ? '⚖️ Выровнено' : '⚠️ Не выровнять'}: ${s.dealer} ${s.month} — ` +
        r.detail.map((d) => `${d.p}: ${d.before} → ${d.after ?? d.before} (утверждено ${d.base})${d.reason ? ' — ' + d.reason : ''}`).join('; '));
    } catch (e) {
      notices.push({ dealer: s.dealer, month: s.month, at: new Date().toISOString(), kind: 'autofix_failed',
        detail: JSON.stringify([{ p: '', reason: String(e.message || e).slice(0, 300), moves: [] }]) });
      console.log(`❌ ${s.dealer} ${s.month}: ${e.message}`);
    }
  }
  if (notices.length) d1ExecFile(buildInserts('cc_mp_notices', ['dealer', 'month', 'at', 'kind', 'detail'], notices).join('\n') + '\n', 'mp-notices');
}

if (process.argv[1] && process.argv[1].endsWith('mp_autofix.mjs')) main().catch((e) => { console.error(e); process.exit(1); });
