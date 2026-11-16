// Снимок дилера для дашборда (замена Cube_Builder.gs): колоночные массивы + словари строк.
// Формат совместим с cbEncode_ (v1): те же поля dict/cols, даты — смещение в днях от base.
// Отличие v2: строки заранее сгруппированы по всем измерениям (суммы те же, строк меньше).

/** Измерения снимка: ключ в снимке → колонка daily_statistics. Порядок важен — это GROUP BY. */
export const SNAP_DIMS = [
  ['pl', 'Platform'],
  ['dtp', 'Dealer_Type'],
  ['mo', 'Marketing_Objective'],
  ['ct', 'Campaign_Type'],
  ['br', 'Car_Brand'],
  ['md', 'Car_Model'],
  ['cn', 'Campaign_Name']
];

/** Показатели: ключ в снимке → колонка. */
export const SNAP_METRICS = [
  ['imp', 'Impressions'],
  ['rch', 'Reach'],
  ['clk', 'Clicks'],
  ['cnv', 'Conversions'],
  ['usd', 'Spend_USD'],
  ['kzt', 'Spend_KZT']
];

const MONEY = new Set(['usd', 'kzt']);
const SPEND_PRECISION = 100; // 2 знака, как CB_SPEND_PRECISION

/** SQL одного дилера: агрегаты по дню × всем измерениям. Параметр — Dealer_ID литералом. */
export function snapshotSql(dealerLiteral) {
  const dims = SNAP_DIMS.map(([, c]) => c);
  const sums = SNAP_METRICS.map(([k, c]) => `SUM(${c}) AS ${k}`);
  return `SELECT Date, ${dims.join(', ')}, ${sums.join(', ')} FROM daily_statistics ` +
    `WHERE Dealer_ID = ${dealerLiteral} GROUP BY Date, ${dims.join(', ')} ORDER BY Date`;
}

function dict() {
  const map = new Map();
  const list = [];
  return {
    list,
    id(v) {
      const key = v === null || v === undefined ? '' : String(v);
      let i = map.get(key);
      if (i === undefined) { i = list.length; map.set(key, i); list.push(key); }
      return i;
    }
  };
}

function dayOf(iso) {
  const s = String(iso);
  return Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Кодирует строки (результат snapshotSql) в снимок.
 * @param {string} dealerId
 * @param {object[]} rows — {Date, Platform, …, imp, rch, clk, cnv, usd, kzt}
 * @param {string} built — ISO-время сборки
 */
export function encodeSnapshot(dealerId, rows, built = new Date().toISOString()) {
  const dicts = Object.fromEntries(SNAP_DIMS.map(([k]) => [k, dict()]));
  const cols = { dt: [] };
  for (const [k] of SNAP_DIMS) cols[k] = [];
  for (const [k] of SNAP_METRICS) cols[k] = [];

  const sorted = rows.filter((r) => r && r.Date).slice().sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
  const base = sorted.length ? String(sorted[0].Date).slice(0, 10) : built.slice(0, 10);
  const baseDay = dayOf(base);

  for (const r of sorted) {
    cols.dt.push(dayOf(r.Date) - baseDay);
    for (const [k, c] of SNAP_DIMS) cols[k].push(dicts[k].id(r[c]));
    for (const [k] of SNAP_METRICS) {
      const v = num(r[k]);
      cols[k].push(MONEY.has(k) ? Math.round(v * SPEND_PRECISION) / SPEND_PRECISION : Math.round(v));
    }
  }

  return {
    v: 2,
    dealer: dealerId,
    built,
    base,
    last: sorted.length ? String(sorted[sorted.length - 1].Date).slice(0, 10) : null,
    n: cols.dt.length,
    dict: Object.fromEntries(SNAP_DIMS.map(([k]) => [k, dicts[k].list])),
    cols
  };
}

/** Обратное преобразование (для проверок): массив строк-объектов. */
export function decodeSnapshot(snap) {
  const out = [];
  const baseDay = dayOf(snap.base);
  for (let i = 0; i < snap.n; i++) {
    const r = { Date: new Date((baseDay + snap.cols.dt[i]) * 86400000).toISOString().slice(0, 10) };
    for (const [k, c] of SNAP_DIMS) r[c] = snap.dict[k][snap.cols[k][i]];
    for (const [k] of SNAP_METRICS) r[k] = snap.cols[k][i];
    out.push(r);
  }
  return out;
}

/** Суммы по площадке × месяцу — для сверки снимка с SQL и со старым дашбордом. */
export function totalsByPlatformMonth(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.Platform + '|' + String(r.Date).slice(0, 7);
    const a = map.get(key) || { Platform: r.Platform, month: String(r.Date).slice(0, 7), imp: 0, rch: 0, clk: 0, cnv: 0, usd: 0, kzt: 0 };
    for (const [k] of SNAP_METRICS) a[k] += num(r[k]);
    map.set(key, a);
  }
  return [...map.values()].sort((a, b) => (a.Platform + a.month).localeCompare(b.Platform + b.month));
}
