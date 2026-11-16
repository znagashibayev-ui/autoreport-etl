// Срез конверсий до Autoreport Hub — перенос 1:1 из Apps Script Gaps_HubCap.gs (hcCapCore_ + hcApply_), который каждый день
// в 09:00 (hcDaily) и после каждой «Догрузить» уменьшает конверсии BigQuery до чисел листа «Ads Data» медиаплана дилера:
//   • по кампании, где конверсий больше, чем в Ads Data, лишнее снимается пропорционально по дням (целыми числами);
//   • кампании, которых в Ads Data нет (а площадка там есть), получают 0; площадку, которой в Ads Data нет, не трогаем;
//   • учитываются только дни до последней даты Ads Data; расход, показы, клики не меняются.
// Здесь срез делается над свежими строками выгрузки ДО записи в D1 и до сверки с BigQuery — итог тот же, что после hcDaily.
// Остальные площадки дилера (для отнесения кампаний Ads Data без слова площадки) берутся из D1.

import { cellDate } from '../platforms/googleads.mjs';

export const MG_PLATFORMS = [
  { key: 'Google Ads', re: /^(google|gads|youtube)(_|-|$)/ },
  { key: 'Meta', re: /^(meta|fb|facebook|instagram)(_|-|$)/ },
  { key: 'TikTok', re: /^(tiktok|tt)(_|-|$)/ },
  { key: 'Yandex', re: /^(yandex|yd|direct)(_|-|$)/ }
];
const MG_FX_TOKENS = { google: 'Google Ads', gads: 'Google Ads', youtube: 'Google Ads', meta: 'Meta', facebook: 'Meta', instagram: 'Meta', tiktok: 'TikTok', yandex: 'Yandex' };
const DEFAULT_ADS_SHEET = 'Ads Data';

/** mgPlatformOf_ + mgPlatformByToken_ (Gaps_Fix.gs). */
export function platformOf(lname) {
  const s = String(lname || '').toLowerCase();
  if (!s) return null;
  for (const p of MG_PLATFORMS) if (p.re.test(s)) return p.key;
  for (const t of s.split(/[^a-z0-9]+/)) if (t && Object.prototype.hasOwnProperty.call(MG_FX_TOKENS, t)) return MG_FX_TOKENS[t];
  return null;
}

export function mgNum(v) {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[\s ]/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}
const extractId = (v) => { const s = String(v || '').trim(); const m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/); return m ? m[1] : /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : ''; };

/** Лист Registry Hub → [{id, ss, sheet}] (mgRegistry_: активные, с медиапланом, без дублей). */
export function parseAdsRegistry(values) {
  if (!values || !values.length) return [];
  const head = values[0].map((h) => String(h).trim().toLowerCase());
  const cId = head.indexOf('dealer_id'); const cAct = head.indexOf('active');
  const cSs = head.indexOf('mp_spreadsheet_id'); const cSh = head.indexOf('mp_sheet_name');
  if (cId < 0 || cSs < 0) throw new Error('В Registry не найдены колонки dealer_id / mp_spreadsheet_id');
  const out = []; const seen = {};
  for (let i = 1; i < values.length; i++) {
    const v = values[i] || [];
    const id = String(v[cId] || '').trim();
    if (!id) continue;
    if (cAct >= 0 && (v[cAct] === false || String(v[cAct]).trim().toUpperCase() === 'FALSE')) continue;
    const ss = extractId(v[cSs]);
    if (!ss || seen[id.toLowerCase()]) continue;
    seen[id.toLowerCase()] = true;
    out.push({ id, ss, sheet: (cSh >= 0 ? String(v[cSh] || '').trim() : '') || DEFAULT_ADS_SHEET });
  }
  return out;
}

/** Вкладка Mapping Hub → {старое: новое} (hcMapping_). */
export function parseMapping(values) {
  const map = {};
  for (let i = 1; i < (values || []).length; i++) {
    const a = String((values[i] || [])[0] || '').trim().toLowerCase(); const b = String((values[i] || [])[1] || '').trim().toLowerCase();
    if (a && b && a !== b) map[a] = b;
  }
  return map;
}
export function mapName(map, c) {
  const s = String(c || '');
  if (Object.prototype.hasOwnProperty.call(map, s)) return map[s];
  const k = s.replace(/_another$/, '');
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : s;
}

/** Колонки Ads Data по заголовкам (hcAdsCols_). */
function adsCols(vals) {
  const c = { d: 0, n: 1, cv: 5, sp: -1 }; const found = { n: false, cv: false, sp: false };
  for (let i = 0; i < Math.min(vals.length, 5); i++) {
    const row = vals[i] || [];
    for (let j = 0; j < row.length; j++) {
      const s = String(row[j] === null || row[j] === undefined ? '' : row[j]).trim().toLowerCase();
      if (!s) continue;
      if (/^(дата|date)$/.test(s)) c.d = j;
      else if (/кампани|campaign/.test(s)) { c.n = j; found.n = true; } else if (/конверси|conversion/.test(s)) { c.cv = j; found.cv = true; } else if (/расход|spend|cost|затрат/.test(s)) { c.sp = j; found.sp = true; }
    }
    if (found.n && found.cv) break;
  }
  if (!found.sp) c.sp = vals[0] && vals[0].length > 6 ? 6 : -1;
  return c;
}

/** Ads Data за месяц (hcParseAds_): на кампанию — строка с самой поздней датой; одинаковая дата — сумма. */
export function parseAds(vals, month) {
  vals = (vals || []).map((r) => (r || []).slice(0, 12)); // hcReadAds_ читает не больше 12 колонок
  const C = adsCols(vals);
  const camp = {}; const order = []; let maxDt = ''; let rows = 0;
  for (const row of vals) {
    const dt = cellDate(row[C.d]);
    if (!dt || dt.slice(0, 7) !== month) continue;
    const name = String(row[C.n] === null || row[C.n] === undefined ? '' : row[C.n]).trim();
    if (!name) continue;
    const cv = mgNum(row[C.cv]); const sp = C.sp >= 0 ? mgNum(row[C.sp]) : 0;
    rows++;
    if (dt > maxDt) maxDt = dt;
    const lname = name.toLowerCase(); const p = platformOf(lname);
    const k = (p || '?') + '|' + lname; const cur = camp[k];
    if (!cur) { camp[k] = { p, name: lname, dt, cv, sp }; order.push(k); } else if (dt > cur.dt) { cur.dt = dt; cur.cv = cv; cur.sp = sp; } else if (dt === cur.dt) { cur.cv += cv; cur.sp += sp; }
  }
  const list = []; const unk = [];
  for (const k of order) (camp[k].p ? list : unk).push(camp[k]);
  return { camp: list, unk, maxDt, rows };
}

export function index(adsCamps) {
  const names = adsCamps.map((c) => c.name).sort((x, y) => y.length - x.length);
  const exact = {};
  for (const n of names) exact[n] = true;
  return { names, exact };
}
export function assign(m, ix) {
  if (ix.exact[m]) return m;
  for (const n of ix.names) if (m.indexOf(n) === 0) return n;
  return null;
}

/** hcIntTargets_: целые цели по кампаниям, сумма = round(сумма Ads Data). */
function intTargets(camps) {
  let tot = 0;
  for (const c of camps) tot += Math.max(0, c.cv);
  const T = Math.round(tot);
  const arr = camps.map((c) => { const x = Math.max(0, c.cv); const f = Math.floor(x); return { n: c.name, v: f, fr: x - f }; });
  let base = 0;
  for (const o of arr) base += o.v;
  let extra = T - base;
  arr.slice().sort((p, q) => q.fr - p.fr || (p.n < q.n ? -1 : 1)).forEach((o) => { if (extra > 0 && o.fr > 0) { o.v++; extra--; } });
  const out = {};
  for (const o of arr) out[o.n] = o.v;
  return out;
}

/** hcDistribute_: target по корзинам пропорционально (целые); только корзины, где число уменьшилось. */
function distribute(buckets, target) {
  let tot = 0;
  for (const b of buckets) tot += b.cv;
  if (tot <= target) return [];
  const res = buckets.map((b) => { const x = tot > 0 ? (b.cv * target) / tot : 0; const f = Math.floor(x); return { k: b.k, old: b.cv, n: f, fr: x - f }; });
  let sum = 0;
  for (const o of res) sum += o.n;
  let extra = target - sum;
  res.slice().sort((p, q) => (q.fr - p.fr) || (q.old - p.old) || (p.k < q.k ? -1 : 1)).forEach((o) => { if (extra > 0) { o.n++; extra--; } });
  return res.filter((o) => o.n < o.old).map((o) => ({ k: o.k, old: o.old, n: o.n }));
}

const bucketKey = (r) => r.Date + '|' + String(r.Campaign_Name || '').toLowerCase().replace(/_another$/, '');

/**
 * Срез строк одного дилера за месяц по одной площадке (hcCapCore_ + распределение внутри корзины из hcApply_).
 * @param {object[]} rows      свежие строки площадки platform этого дилера за месяц — меняются на месте
 * @param {object} ads         parseAds(...)
 * @param {{Platform: string, Date: string, Campaign_Name: string, Conversions: number}[]} others  строки других площадок дилера (D1)
 * @returns {{before: number, after: number, cut: number, skipped?: string}}
 */
export function capDealerMonth(rows, ads, month, platform, others = [], mapping = {}) {
  const pr = { before: 0, after: 0, cut: 0, changes: [] };
  if (!ads.rows) return { ...pr, skipped: 'в Ads Data нет строк за месяц' };
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const end = month + '-' + String(last).padStart(2, '0');
  const cap = ads.maxDt && ads.maxDt < end ? ads.maxDt : end;

  // hcBqDaily_: корзины «дата|кампания» по площадкам (свежие строки + остальные площадки из D1)
  const bqd = {};
  const add = (r) => {
    if (r.Date > cap || r.Date.slice(0, 7) !== month) return;
    const p = r.Platform; const k = bucketKey(r);
    const byK = (bqd[p] = bqd[p] || new Map());
    const b = byK.get(k) || { dt: r.Date, c: k.slice(11), cv: 0, usd: 0, kzt: 0, rows: [] };
    b.cv += Number(r.Conversions) || 0;
    b.usd += Number(r.Spend_USD) || 0; b.kzt += Number(r.Spend_KZT) || 0;
    if (p === platform) b.rows.push(r);
    byK.set(k, b);
  };
  rows.forEach(add);
  others.filter((r) => r.Platform !== platform).forEach(add);
  // HAVING из hcBqDaily_: корзина видна, если сумма конверсий или расхода не 0
  const list = (p) => [...(bqd[p] || new Map()).values()].filter((b) => b.cv !== 0 || b.usd !== 0 || b.kzt !== 0).map((b) => ({ ...b, m: mapName(mapping, b.c) }));

  // hcResolveUnknown_: кампании Ads Data без слова площадки → площадка, где больше строк с этим названием
  const camp = ads.camp.slice();
  for (const u of ads.unk) {
    let best = null; let bestN = 0;
    for (const P of MG_PLATFORMS) {
      const n = list(P.key).filter((r) => r.m === u.name || r.m.indexOf(u.name) === 0).length;
      if (n > bestN) { bestN = n; best = P.key; }
    }
    if (best) camp.push({ p: best, name: u.name, cv: u.cv });
  }

  const adsCamps = camp.filter((c) => c.p === platform);
  const buckets = list(platform).filter((x) => x.cv > 0);
  for (const b of buckets) pr.before += b.cv;
  pr.after = pr.before;
  if (!buckets.length) return pr;
  if (!adsCamps.length) return { ...pr, skipped: 'площадки нет в Ads Data — не трогаем' };
  const ix = index(adsCamps); const tg = intTargets(adsCamps);
  const groups = {}; const gOrder = [];
  for (const x of buckets) {
    const m = assign(x.m, ix);
    const gk = m ? 'a|' + m : 'x|' + x.m;
    if (!groups[gk]) { groups[gk] = { target: m ? tg[m] || 0 : 0, buckets: [] }; gOrder.push(gk); }
    groups[gk].buckets.push({ k: x.dt + '|' + x.c, cv: x.cv, rows: x.rows });
  }
  for (const gk of gOrder) {
    const g = groups[gk];
    for (const ch of distribute(g.buckets, g.target)) {
      const b = g.buckets.find((x) => x.k === ch.k);
      splitBucket(b.rows, Math.max(0, Math.round(ch.n)));
      pr.cut += ch.old - ch.n;
      pr.changes.push({ k: ch.k, old: ch.old, n: ch.n });
    }
  }
  pr.after = pr.before - pr.cut;
  return pr;
}

/** Распределение нового числа корзины по её строкам — как SQL в hcApply_ (пропорционально, остаток — по дробной части). */
function splitBucket(rows, n) {
  let tot = 0;
  for (const r of rows) tot += Number(r.Conversions) || 0;
  const xs = rows.map((r) => { const x = tot > 0 ? ((Number(r.Conversions) || 0) * n) / tot : 0; return { r, x, b: Math.floor(x) }; });
  let extra = n;
  for (const o of xs) extra -= o.b;
  // shortcut: последний ключ сортировки в BigQuery — FARM_FINGERPRINT строки; здесь — имя кампании и модель (влияет только на полные ничьи)
  xs.slice().sort((p, q) => (q.x - q.b) - (p.x - p.b) || (Number(q.r.Conversions) || 0) - (Number(p.r.Conversions) || 0) ||
    String(p.r.Campaign_Name + '|' + p.r.Car_Model).localeCompare(String(q.r.Campaign_Name + '|' + q.r.Car_Model)))
    .forEach((o, i) => { o.r.Conversions = o.b + (i < extra ? 1 : 0); });
}

/**
 * Срез всех свежих строк площадки (hcDaily по дилерам из Registry Hub, по каждому месяцу окна). Строки меняются на месте.
 * @param {object[]} rows  свежие строки площадки
 * @param {{registry: {id: string, ss: string, sheet: string}[], mapping: object, readAds: (reg: object) => Promise<unknown[][]>,
 *          others: object[]}} o  others — строки остальных площадок за окно (Dealer_ID, Platform, Date, Campaign_Name, …)
 * @returns {Promise<{cut: number, dealers: {dealer: string, cut: number, before: number}[], errors: string[]}>}
 */
export async function applyHubCap(rows, platform, o) {
  const regBy = new Map(o.registry.map((r) => [r.id.toLowerCase(), r]));
  const group = (list) => {
    const m = new Map();
    for (const r of list) {
      const k = String(r.Dealer_ID || '').toLowerCase() + '|' + String(r.Date).slice(0, 7);
      (m.get(k) || m.set(k, []).get(k)).push(r);
    }
    return m;
  };
  const mine = group(rows); const others = group(o.others || []);
  const out = { cut: 0, dealers: [], errors: [] };
  const adsCache = new Map();
  for (const [k, dr] of mine) {
    const [dealer, month] = k.split('|');
    const reg = regBy.get(dealer);
    if (!reg) continue; // дилера нет в Registry Hub — hcDaily его не трогает
    if (!adsCache.has(reg.id)) adsCache.set(reg.id, o.readAds(reg).catch((e) => ({ error: e.message })));
    const values = await adsCache.get(reg.id);
    if (values && values.error) { if (!out.errors.some((x) => x.startsWith(reg.id + ':'))) out.errors.push(reg.id + ': ' + values.error); continue; }
    const pr = capDealerMonth(dr, parseAds(values, month), month, platform, others.get(k) || [], o.mapping);
    if (pr.cut) { out.cut += pr.cut; out.dealers.push({ dealer: dr[0].Dealer_ID + ' · ' + month, cut: pr.cut, before: pr.before }); }
  }
  return out;
}
