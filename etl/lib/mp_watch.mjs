// Контроль медиаплана: снимок листа месяца, сравнение со снимком прошлого чтения (что изменилось, ячейка за ячейкой)
// и итоги «Общий бюджет» (столбец S) по площадкам — план и факт. Без зависимостей от Node: используется заданиями и сайтом.
//
// Снимок — значения таблицы плана (строки листа до блока «Total» включительно и таблица комиссий, столбцы до конца таблицы плана).
// Подписи строк — «кампания · План/Факт» или «площадка · итог · План/Факт/Выполнение», столбцов — заголовок таблицы.

import { colLetter, d1Platform, parseMonthSheet, pfKind } from './mediaplan.mjs';

const MAX_CHANGES = 400;

const norm = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : '';
  if (typeof v === 'boolean') return v;
  return String(v).trim();
};

/**
 * Итоги по площадкам и всего, план и факт: «Общий бюджет» S ($ без НДС и АК), «Общий бюджет, тг» T (₸ без НДС и АК),
 * конверсии Q; planGross / factGross — W «Бюджет с НДС и ВИ, тг» (только для расчёта долей, людям не показывается).
 */
export function totalsOf(meta) {
  // одна площадка = одна строка: в листе бывает два блока с одним названием (BYD Shymcity, 11.11.2026: «Tiktok» в строках 41 и 53) — складываем
  const byP = new Map();
  for (const p of meta.platforms || []) {
    const f = p.fact || {};
    // ключ '' = «весь медиаплан» (cc_mp_baseline). Блок без названия площадки (Distributor_BYD, 12.11.2026) занимал его:
    // первый снимок записал «весь медиаплан = $0», а «Утвердить» падал на повторном ключе. Пустой блок пропускаем, с деньгами — по строке.
    const name = d1Platform(p.platform) || String(p.platform || '').trim();
    if (!name && !(p.total > 0) && !(f.total > 0)) continue;
    const x = { p: name || `Без названия (строка ${p.row})`, plan: p.total, fact: f.total || 0, planKzt: p.kzt ?? null, factKzt: f.kzt ?? null,
      planConv: p.conv || 0, factConv: f.conv || 0, planDaily: p.daily || 0, factDaily: f.daily || 0, planGross: p.gross, factGross: f.gross || 0 };
    const o = byP.get(x.p);
    if (!o) { byP.set(x.p, x); continue; }
    for (const k of Object.keys(x)) if (k !== 'p' && (x[k] !== null || o[k] !== null)) o[k] = (o[k] || 0) + (x[k] || 0);
  }
  const platforms = [...byP.values()];
  const sum = (k) => Math.round(platforms.reduce((s, x) => s + (x[k] || 0), 0) * 100) / 100;
  const t = meta.total || {};
  const pick = (row, key, k) => (row && row[key] !== null && row[key] !== undefined ? row[key] : sum(k));
  return {
    platforms,
    plan: pick(t.plan, 'total', 'plan'), fact: pick(t.fact, 'total', 'fact'),
    planKzt: pick(t.plan, 'kzt', 'planKzt'), factKzt: pick(t.fact, 'kzt', 'factKzt'),
    planConv: pick(t.plan, 'conv', 'planConv'), factConv: pick(t.fact, 'conv', 'factConv'),
    planDaily: pick(t.plan, 'daily', 'planDaily'), factDaily: pick(t.fact, 'daily', 'factDaily'),
    planGross: pick(t.plan, 'gross', 'planGross'), factGross: pick(t.fact, 'gross', 'factGross'),
    budget: meta.budget, rate: meta.rate, days: meta.days
  };
}

/**
 * Снимок листа месяца.
 * @param {unknown[][]} values значения листа с A1 (UNFORMATTED_VALUE)
 * @returns {{cells: unknown[][], totals: object, labels: {rows: Object<number,string>, kinds: Object<number,string>, cols: string[]}, mp: object}}
 */
export function snapshot(values) {
  const mp = parseMonthSheet(values);
  const width = Math.max(mp.meta.lastCol + 1, 8);
  const cells = (values || []).map((row) => {
    const out = (row || []).slice(0, width).map(norm);
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  });
  while (cells.length && !cells[cells.length - 1].length) cells.pop();
  const totals = totalsOf(mp.meta);
  totals.issues = structureIssues(values, mp); // проверка устройства листа — вместе с итогами, без отдельной таблицы
  return { cells, totals, labels: labelsOf(values, mp), mp };
}

/** Подписи строк и столбцов для журнала. kinds: plan | fact — что меняется (план должен стоять, факт растёт каждый день). */
export function labelsOf(values, mp) {
  const rows = {}; const kinds = {};
  const hr = mp.meta.headerRow;
  const head = ((values || [])[hr - 1] || []).map((h) => String(h ?? '').replace(/\s+/g, ' ').trim());
  const pfCol = 3;
  for (let r = 1; r < hr; r++) { rows[r] = 'Период и бюджет'; kinds[r] = 'plan'; }
  rows[hr] = 'Заголовок таблицы'; kinds[hr] = 'plan';
  const seen = {};
  for (const p of mp.meta.platforms) {
    let name = d1Platform(p.platform) || p.platform || 'Площадка';
    if (seen[name]) name += ' (блок в строке ' + p.row + ')'; // второй блок той же площадки — подпись не должна совпасть с первым
    seen[name] = 1;
    name += ' · итог';
    rows[p.row] = name + ' · План'; kinds[p.row] = 'plan';
    rows[p.row + 1] = name + ' · Факт'; kinds[p.row + 1] = 'fact';
    rows[p.row + 2] = name + ' · Выполнение'; kinds[p.row + 2] = 'fact';
  }
  for (const c of mp.rows) {
    const n = c.name || '(пустая строка ' + (c.d1 || c.platform) + ')';
    rows[c.row] = n + ' · План'; kinds[c.row] = 'plan';
    if (c.fact) { rows[c.row + 1] = n + ' · Факт'; kinds[c.row + 1] = 'fact'; }
  }
  for (const k of ['plan', 'fact']) {
    const t = (mp.meta.total || {})[k];
    if (t) { rows[t.row] = 'Total · ' + (k === 'plan' ? 'План' : 'Факт'); kinds[t.row] = k; }
  }
  // строки без подписи: по слову в столбце «План/Факт» (Выполнение — факт), иначе — план (комиссии, курсы)
  (values || []).forEach((row, i) => {
    const r = i + 1;
    if (rows[r]) return;
    const pf = pfKind((row || [])[pfCol]);
    rows[r] = 'Строка ' + r;
    kinds[r] = pf === 'fact' || pf === 'exec' ? 'fact' : 'plan';
  });
  return { rows, kinds, cols: head };
}

/** Итоги S, которые изменились: [{p, plan: [было, стало], fact: [было, стало]}]. */
export function totalsDiff(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  const key = (t) => Object.fromEntries((t.platforms || []).map((x) => [x.p, x]));
  const a = key(prev); const b = key(next);
  for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    const x = a[p] || {}; const y = b[p] || {};
    const d = { p };
    if (Math.abs((x.plan || 0) - (y.plan || 0)) >= 0.01 || Math.abs((x.planKzt || 0) - (y.planKzt || 0)) >= 1) d.plan = [x.plan ?? null, y.plan ?? null, x.planKzt ?? null, y.planKzt ?? null];
    if (Math.abs((x.fact || 0) - (y.fact || 0)) >= 0.01) d.fact = [x.fact ?? null, y.fact ?? null];
    if (d.plan || d.fact) out.push(d);
  }
  if (Math.abs((prev.plan || 0) - (next.plan || 0)) >= 0.01 || Math.abs((prev.planKzt || 0) - (next.planKzt || 0)) >= 1) {
    out.push({ p: '', plan: [prev.plan, next.plan, prev.planKzt ?? null, next.planKzt ?? null] });
  }
  return out;
}

/**
 * Что изменилось между снимками: ячейки с подписями. Пустой список — изменений нет.
 * @returns {{changes: {a1, row, col, old, new, kind}[], n: number, kind: 'plan'|'fact'|'mixed'|''}}
 */
export function diffCells(prevCells, nextCells, labels) {
  const changes = [];
  let n = 0;
  const rowsN = Math.max(prevCells.length, nextCells.length);
  for (let r = 0; r < rowsN; r++) {
    const a = prevCells[r] || []; const b = nextCells[r] || [];
    const colsN = Math.max(a.length, b.length);
    for (let c = 0; c < colsN; c++) {
      const x = a[c] ?? ''; const y = b[c] ?? '';
      if (x === y) continue;
      n++;
      if (changes.length < MAX_CHANGES) {
        changes.push({ a1: colLetter(c) + (r + 1), row: labels.rows[r + 1] || 'Строка ' + (r + 1), col: labels.cols[c] || colLetter(c),
          old: x, new: y, kind: labels.kinds[r + 1] || 'plan' });
      }
    }
  }
  const kinds = new Set(changes.map((x) => x.kind));
  return { changes, n, kind: !n ? '' : kinds.size > 1 ? 'mixed' : [...kinds][0] };
}

/** Повторы имени кампании в листе (кампания добавлена дважды): [{name, rows: [строки]}]. */
export function duplicates(rows) {
  const by = {};
  for (const r of rows || []) if (r.name) (by[r.name.toLowerCase()] = by[r.name.toLowerCase()] || { name: r.name, rows: [] }).rows.push(r.row);
  return Object.values(by).filter((x) => x.rows.length > 1);
}

/**
 * Отклонения от утверждённого плана: [{p, base, now, diff, baseGross, nowGross, diffGross}] — где разница ≥ 0,01 по S или ≥ 1 ₸.
 * @param {object} totals итоги снимка
 * @param {{platform: string, plan: number, plan_kzt: number|null}[]} baseline утверждённый план (platform '' — весь медиаплан);
 *        ₸ — столбец T «Общий бюджет, тг»; у утверждений до 11.11.2026 его нет (plan_kzt null) — тогда сверка только по S
 */
export function deviations(totals, baseline) {
  if (!totals || !baseline || !baseline.length) return [];
  const now = Object.fromEntries((totals.platforms || []).map((x) => [x.p, x]));
  now[''] = { plan: totals.plan, planKzt: totals.planKzt };
  const out = [];
  for (const b of baseline) {
    const x = now[b.platform] || { plan: 0, planKzt: 0 };
    const d = Math.round(((x.plan || 0) - (b.plan || 0)) * 100) / 100;
    // только столбец S «Общий бюджет»: владелец смотрит Q, R, S (11.11.2026); T = S × курс — отдельно не сверяется
    if (Math.abs(d) >= 0.01) out.push({ p: b.platform, base: b.plan, now: x.plan || 0, diff: d });
  }
  return out;
}

/** Строки журнала и снимка для записи в D1 (без SQL: SQL собирает вызывающий). */
export function watchRecords({ dealer, month, ss, sheet, values, prev, at, modified = null, who = null, source = 'table' }) {
  const snap = snapshot(values);
  const cellsRow = { dealer, month, ss, sheet, cells: JSON.stringify(snap.cells), totals: JSON.stringify(snap.totals), modified, who, at };
  const baseline = snap.totals.platforms.map((x) => ({ dealer, month, platform: x.p, plan: x.plan, plan_gross: x.planGross, plan_kzt: x.planKzt, set_at: at, set_by: 'first' }))
    .concat([{ dealer, month, platform: '', plan: snap.totals.plan, plan_gross: snap.totals.planGross, plan_kzt: snap.totals.planKzt, set_at: at, set_by: 'first' }]);
  if (!prev || !prev.cells) {
    return { snap, cellsRow, baseline, log: { dealer, month, sheet, at, modified, who, source: 'first', kind: '', n: 0, changes: '[]', totals: '[]' } };
  }
  let prevCells = [];
  try { prevCells = JSON.parse(prev.cells) || []; } catch { /* битый снимок — всё как новое */ }
  let prevTotals = null;
  try { prevTotals = JSON.parse(prev.totals || 'null'); } catch { /* пусто */ }
  const d = diffCells(prevCells, snap.cells, snap.labels);
  if (!d.n) return { snap, cellsRow, baseline, log: null };
  const td = totalsDiff(prevTotals, snap.totals);
  return { snap, cellsRow, baseline,
    log: { dealer, month, sheet, at, modified, who, source, kind: d.kind, n: d.n, changes: JSON.stringify(d.changes), totals: JSON.stringify(td) } };
}

export const CELLS_COLS = ['dealer', 'month', 'ss', 'sheet', 'cells', 'totals', 'modified', 'who', 'at'];
export const LOG_COLS = ['dealer', 'month', 'sheet', 'at', 'modified', 'who', 'source', 'kind', 'n', 'changes', 'totals'];
export const BASE_COLS = ['dealer', 'month', 'platform', 'plan', 'plan_gross', 'plan_kzt', 'set_at', 'set_by'];

/* ---------- проверка структуры листа ---------- */

// #DIV/0! — обычное дело в медиаплане (деление на пустой факт), сломанной формулой не считается
const ERR_RE = /^#(REF!|N\/A|VALUE!|NAME\?|NUM!|ERROR!|NULL!)/;

/**
 * Ошибки устройства листа месяца: [{type, text, row?}] — пустые имена с бюджетом, кампании без строки «Факт»,
 * доли кампаний площадки не в сумме 100%, доли площадок не в сумме 100%, ячейки с ошибкой формулы (#REF! …).
 */
export function structureIssues(values, mp) {
  const out = [];
  const pName = (r) => d1Platform(r.platform) || r.platform || 'площадка';
  for (const p of mp.meta.platforms) {
    if (!d1Platform(p.platform) && !String(p.platform || '').trim() && (p.total > 0 || (p.fact && p.fact.total > 0))) {
      out.push({ type: 'noplatform', row: p.row, text: `Строка ${p.row}: блок «План» с бюджетом без названия площадки в столбце A — впишите площадку (Google Ads, Meta, TikTok, Yandex)` });
    }
  }
  for (const r of mp.rows) {
    if (!r.name && (r.share > 0 || r.daily > 0)) out.push({ type: 'noname', row: r.row, text: `Строка ${r.row} (${pName(r)}): нет имени кампании, а бюджет ${Math.round(r.daily * 100) / 100} $/день` });
    if (r.name && !r.fact) out.push({ type: 'nofact', row: r.row, text: `Строка ${r.row} «${r.name}»: нет строки «Факт» под «План» — факт кампании не считается` });
  }
  for (const p of mp.meta.platforms) {
    const own = mp.rows.filter((r) => r.platform === p.platform);
    if (!(p.gross > 0) || !own.length) continue;
    const sum = own.reduce((s, r) => s + (r.share || 0), 0);
    // S площадки = сумма кампаний, поэтому при долях не 100% план S отличается от бюджета площадки на эту сумму
    const miss = sum > 0 ? Math.round((p.total / sum - p.total) * 100) / 100 : 0;
    if (Math.abs(sum - 1) > 0.001) out.push({ type: 'share', row: p.row, miss, text: `${pName(p)}: доли кампаний в сумме ${Math.round(sum * 1000) / 10}% вместо 100% — ${sum < 1 ? 'не распределено' : 'распределено сверх бюджета площадки'} $${Math.abs(miss).toFixed(2)} «Общего бюджета» (S)` });
  }
  const blocks = {};
  for (const p of mp.meta.platforms) (blocks[pName(p)] = blocks[pName(p)] || []).push(p.row);
  for (const [n, rs] of Object.entries(blocks)) {
    if (rs.length > 1) out.push({ type: 'dupplatform', row: rs[1], text: `Площадка ${n} встречается в листе ${rs.length} раза (строки-итоги ${rs.join(', ')}) — суммы блоков складываются в одну площадку. Если второй блок — другая площадка (например, Yandex), переименуйте его в столбце A` });
  }
  const ps = mp.meta.platforms.reduce((s, p) => s + (p.share || 0), 0);
  if (mp.meta.platforms.length && Math.abs(ps - 1) > 0.001) out.push({ type: 'pshare', text: `Доли площадок в сумме ${Math.round(ps * 1000) / 10}% вместо 100% — ${ps < 1 ? 'часть бюджета медиаплана не распределена' : 'распределено больше бюджета'}` });
  const width = mp.meta.lastCol + 1;
  let errs = 0;
  (values || []).forEach((row, i) => (row || []).slice(0, width).forEach((v, c) => {
    if (typeof v === 'string' && ERR_RE.test(v.trim())) {
      errs++;
      if (errs <= 15) out.push({ type: 'formula', row: i + 1, text: `Ячейка ${colLetter(c)}${i + 1}: ошибка формулы ${v.trim()}` });
    }
  }));
  if (errs > 15) out.push({ type: 'formula', text: `…и ещё ${errs - 15} ячеек с ошибкой формулы` });
  return out;
}

/* ---------- сверка с кабинетами ---------- */

const bNorm = (n) => String(n || '').trim().toLowerCase().replace(/_another$/, '');

/** Сумма кабинета → $ (тенге — по курсу медиаплана). null — валюту не перевести. */
export function cabinetUsd(v, cur, rate) {
  if (!(v > 0)) return null;
  if (!cur || cur === 'USD') return v;
  if (cur === 'KZT' && rate > 0) return v / rate;
  return null;
}

/**
 * Дневной бюджет медиаплана против бюджета в кабинете по каждой кампании листа:
 * [{p, name, row, plan, cab, cabRaw, cur, status, diff, level}] — level: ok | diff (больше $1 и 5%) | paused (в плане есть бюджет, в кабинете остановлена)
 * | missing (кампании нет в кабинете) | nobudget (в кабинете нет дневного бюджета) | off (в плане 0, в кабинете активна с бюджетом).
 */
export function cabinetCheck(rows, budgets, rate) {
  const out = [];
  const read = new Set((budgets || []).map((b) => b.p));
  for (const r of rows || []) {
    if (!r.name || !read.has(r.d1)) continue;
    const list = (budgets || []).filter((b) => b.p === r.d1 && b.n && bNorm(b.n) === bNorm(r.name));
    list.sort((a, b) => (b.s === 'ACTIVE') - (a.s === 'ACTIVE') || (b.d || 0) - (a.d || 0));
    const b = list[0];
    const plan = Math.round((r.daily || 0) * 100) / 100;
    if (!b) { if (plan > 0) out.push({ p: r.d1, name: r.name, row: r.row, plan, cab: null, level: 'missing' }); continue; }
    const cab = cabinetUsd(b.d, b.cur, rate);
    const base = { p: r.d1, name: r.name, row: r.row, plan, cab: cab === null ? null : Math.round(cab * 100) / 100, cabRaw: b.d, cur: b.cur || 'USD', status: b.s || '', mode: b.m || 'campaign' };
    const active = !b.s || b.s === 'ACTIVE';
    if (!active) { out.push({ ...base, level: plan > 0 ? 'paused' : 'ok' }); continue; }
    if (b.m === 'total' || cab === null) { out.push({ ...base, level: plan > 0 ? 'nobudget' : 'ok' }); continue; }
    const diff = Math.round((cab - plan) * 100) / 100;
    if (plan === 0 && cab > 0) out.push({ ...base, diff, level: 'off' });
    else out.push({ ...base, diff, level: Math.abs(diff) > Math.max(1, plan * 0.05) ? 'diff' : 'ok' });
  }
  return out;
}
