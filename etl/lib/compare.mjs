// Сверка агрегатов «старая система ↔ новая»: строки, расход, конверсии по ключу (дилер × площадка …).

const EPS = 0.02; // допуск на округление FLOAT, в тенге/конверсиях

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function close(a, b) {
  return Math.abs(a - b) <= EPS + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * @param {object[]} bqRows    [{...keys, n, spend, conv}]
 * @param {object[]} otherRows те же поля из D1/Parquet
 * @param {string[]} keys
 */
export function compareAggregates(bqRows, otherRows, keys = ['Dealer_ID', 'Platform']) {
  const keyOf = (r) => keys.map((k) => (r[k] === null || r[k] === undefined ? '∅' : String(r[k]))).join('|');
  const map = new Map();
  const empty = () => ({ n: 0, spend: 0, conv: 0 });
  for (const r of bqRows) map.set(keyOf(r), { key: r, bq: { n: num(r.n), spend: num(r.spend), conv: num(r.conv) }, other: empty() });
  for (const r of otherRows) {
    const k = keyOf(r);
    if (!map.has(k)) map.set(k, { key: r, bq: empty(), other: empty() });
    map.get(k).other = { n: num(r.n), spend: num(r.spend), conv: num(r.conv) };
  }
  const rows = [];
  const totals = { bq: empty(), other: empty() };
  let diffs = 0;
  for (const v of map.values()) {
    const ok = v.bq.n === v.other.n && close(v.bq.spend, v.other.spend) && close(v.bq.conv, v.other.conv);
    if (!ok) diffs++;
    for (const side of ['bq', 'other']) {
      totals[side].n += v[side].n;
      totals[side].spend += v[side].spend;
      totals[side].conv += v[side].conv;
    }
    const row = { bq: v.bq, other: v.other, ok };
    for (const k of keys) row[k] = v.key[k] === undefined ? null : v.key[k];
    rows.push(row);
  }
  return { ok: diffs === 0, diffs, rows, totals };
}
