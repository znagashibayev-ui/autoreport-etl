// Недолёты: сверка медиаплана (лист «Ads Data») с D1 по дилеру × площадке × месяцу.
// Перенос 1:1 из Apps Script: hcBuildItem_ + hcMatch_ + hcResolveUnknown_ (Gaps_HubCap.gs), MG_MIN_GAP = 2 (Gaps_Fix2.gs),
// mgGroup_ и брендовое название из Registry (Gaps_WebApp.gs). Источник «фактических» чисел — D1 вместо BigQuery.

import { MG_PLATFORMS, assign, index, mapName } from './hubcap.mjs';

export const MIN_GAP = 2; // MG_FX2_MIN_GAP: ±1 не недолёт (дробные конверсии Google, задержка Яндекса)
const SPEND_CUR = { 'Google Ads': 'USD', Meta: 'USD', TikTok: 'USD', Yandex: 'KZT' };
const SPEND_TOL_PCT = 1;
const SPEND_TOL_ABS = { USD: 1, KZT: 500 };
export const PLATFORM_KEY = { 'Google Ads': 'google', Meta: 'meta', TikTok: 'tiktok', Yandex: 'yandex' }; // → PLATFORM в run_platform

const r2 = (x) => Math.round(x * 100) / 100;

/** mgGroup_: группа дилера по его Dealer_ID. */
export function groupOf(id) {
  const s = String(id).toLowerCase();
  if (s.indexOf('motorrad') >= 0) return 'BMW Motorrad';
  const parts = String(id).split('_');
  const g = String(parts[1] || parts[0] || '').toLowerCase();
  const map = { bmw: 'BMW', byd: 'BYD', jlr: 'JLR', mini: 'MINI', mg: 'MG', gac: 'GAC', jac: 'JAC', faw: 'FAW' };
  if (map[g]) return map[g];
  return g ? g.charAt(0).toUpperCase() + g.slice(1) : String(id);
}

/** Колонка brand листа Registry → { dealer_id в нижнем регистре: название }. */
export function registryTitles(values) {
  const out = {};
  const head = ((values || [])[0] || []).map((h) => String(h).trim().toLowerCase());
  const cId = head.indexOf('dealer_id'); const cBrand = head.indexOf('brand');
  if (cId < 0 || cBrand < 0) return out;
  for (const v of values.slice(1)) {
    const id = String(v[cId] || '').trim().toLowerCase();
    const t = String(v[cBrand] || '').trim();
    if (id && t && !out[id]) out[id] = t;
  }
  return out;
}

function pickCur(platform, adsSp, usd, kzt) {
  if (adsSp > 0 && usd > 0 && kzt > 0) return Math.abs(Math.log(adsSp / usd)) <= Math.abs(Math.log(adsSp / kzt)) ? 'USD' : 'KZT';
  return SPEND_CUR[platform] || 'USD';
}
export function spendOk(a, b, cur) {
  return Math.abs(a - b) <= Math.max(SPEND_TOL_ABS[cur] || 1, (Math.abs(a) * SPEND_TOL_PCT) / 100);
}

/** hcMatch_: кампании с расхождением (конверсии или расход), самые большие сверху, не больше 20. */
function matchCamps(adsCamps, rows, cur) {
  const ix = index(adsCamps);
  const by = {}; const extra = {};
  for (const row of rows) {
    const m = assign(row.m, ix);
    const t = m ? by : extra; const key = m || row.m;
    if (!t[key]) t[key] = { b: 0, sb: 0 };
    t[key].b += row.cv;
    t[key].sb += cur === 'KZT' ? row.kzt : row.usd;
  }
  let list = adsCamps.map((c) => { const g = by[c.name] || { b: 0, sb: 0 }; return { n: c.name, a: r2(c.cv), b: g.b, sa: r2(c.sp), sb: r2(g.sb) }; });
  for (const x of Object.keys(extra)) list.push({ n: x, a: 0, b: extra[x].b, sa: 0, sb: r2(extra[x].sb), x: 1 });
  list = list.filter((o) => Math.abs(Math.round(o.a) - o.b) >= 1 || !spendOk(o.sa, o.sb, cur));
  list.sort((p, q) => (Math.abs(Math.round(q.a) - q.b) - Math.abs(Math.round(p.a) - p.b)) || (Math.abs(q.sa - q.sb) - Math.abs(p.sa - p.sb)));
  return list.slice(0, 20);
}

/**
 * Сверка одного дилера за месяц (hcBuildItem_).
 * @param {{id: string}} reg       строка Registry Hub
 * @param {string} month           YYYY-MM
 * @param {object|{error: string}} ads  parseAds(...) из hubcap.mjs или ошибка чтения медиаплана
 * @param {{Platform: string, Date: string, c: string, cv: number, usd: number, kzt: number}[]} d1  строки D1 дилера за месяц
 *        (сумма по дате × площадке × кампании; c — название кампании в нижнем регистре без _another)
 * @returns {object[]} строки cc_gaps без month/dealer/title/grp/checked
 */
export function buildGaps(reg, month, ads, d1, mapping = {}) {
  if (!ads || ads.error) return [{ platform: '', error: 'Медиаплан (Ads Data) не прочитан: ' + ((ads && ads.error) || 'неизвестная ошибка') }];
  if (!ads.rows) return [{ platform: '', error: 'В медиаплане нет строк за этот месяц', ads_date: null }];
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const end = month + '-' + String(last).padStart(2, '0');
  const cap = ads.maxDt && ads.maxDt < end ? ads.maxDt : end;
  const bqd = {};
  for (const r of d1) {
    if (r.Date > cap || r.Date.slice(0, 7) !== month) continue;
    (bqd[r.Platform] = bqd[r.Platform] || []).push({ ...r, m: mapName(mapping, r.c) });
  }
  // hcResolveUnknown_: кампания без слова площадки → площадка, где больше строк с этим названием
  const camp = ads.camp.slice();
  for (const u of ads.unk || []) {
    let best = null; let bestN = 0;
    for (const P of MG_PLATFORMS) {
      const n = (bqd[P.key] || []).filter((r) => r.m === u.name || r.m.indexOf(u.name) === 0).length;
      if (n > bestN) { bestN = n; best = P.key; }
    }
    if (best) camp.push({ ...u, p: best });
  }
  const out = [];
  for (const P of MG_PLATFORMS) {
    const adsCamps = camp.filter((c) => c.p === P.key);
    let adsSum = 0; let adsSp = 0;
    for (const c of adsCamps) { adsSum += c.cv; adsSp += c.sp || 0; }
    const rows = bqd[P.key] || [];
    let d1Sum = 0; let usd = 0; let kzt = 0;
    for (const r of rows) { d1Sum += r.cv; usd += r.usd; kzt += r.kzt; }
    const adsInt = Math.round(adsSum);
    if (adsInt === 0 && d1Sum === 0 && adsSp === 0 && usd === 0 && kzt === 0) continue;
    let gap = adsInt - d1Sum;
    if (Math.abs(gap) < MIN_GAP) gap = 0;
    const noHub = adsCamps.length === 0;
    const cur = pickCur(P.key, adsSp, usd, kzt);
    const sb = cur === 'KZT' ? kzt : usd;
    const sok = noHub ? null : spendOk(adsSp, sb, cur);
    out.push({
      platform: P.key, ads_conv: r2(adsSum), d1_conv: d1Sum, gap: Math.round(gap), ads_spend: r2(adsSp), d1_spend: r2(sb), spend_cur: cur,
      spend_ok: sok === null ? null : sok ? 1 : 0, no_hub: noHub ? 1 : 0, ads_date: ads.maxDt || null, cap_date: cap,
      camps: gap !== 0 || sok === false ? JSON.stringify(matchCamps(adsCamps, rows, cur)) : null, error: null
    });
  }
  if (!out.length) out.push({ platform: '', error: null, ads_date: ads.maxDt || null, cap_date: cap }); // дилер есть, расходов нет
  return out;
}

/* ---------- сверка с реальными кабинетами (11.11.2026) ---------- */

const campKey = (name) => String(name || '').toLowerCase().replace(/_another$/, ''); // как d1Month в etl/gaps.mjs

/**
 * Итоги выгрузки по кабинетам → строки cc_cabinet. Месяц пишется, только если выгрузка покрыла его с 1-го числа
 * и до min(конец месяца, вчера): частичная выгрузка (отдельные даты) не должна подменять эталон.
 * @param rows       строки daily_statistics, готовые к записи (после курсов и среза до Hub)
 * @param okDealers  дилеры, выгруженные без ошибки (у остальных эталон не трогаем)
 * @param yesterday  вчера 'YYYY-MM-DD' (часовой пояс скрипта)
 */
export function cabinetRecords(rows, okDealers, platform, start, end, yesterday, at = new Date().toISOString()) {
  const out = [];
  for (let m = start.slice(0, 7); m <= end.slice(0, 7);) {
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const need = last < yesterday ? last : yesterday;
    if (start <= m + '-01' && end >= need) {
      const to = end < last ? end : last;
      for (const dealer of okDealers) {
        const c = {}; let conv = 0; let usd = 0; let kzt = 0;
        for (const r of rows) {
          if (r.Dealer_ID !== dealer || String(r.Date).slice(0, 7) !== m || r.Date > to) continue;
          const k = campKey(r.Campaign_Name);
          const x = (c[k] = c[k] || { n: k, cv: 0, usd: 0, kzt: 0 });
          x.cv += Number(r.Conversions) || 0; x.usd += Number(r.Spend_USD) || 0; x.kzt += Number(r.Spend_KZT) || 0;
          conv += Number(r.Conversions) || 0; usd += Number(r.Spend_USD) || 0; kzt += Number(r.Spend_KZT) || 0;
        }
        const camps = Object.values(c).map((x) => ({ n: x.n, cv: r2(x.cv), usd: r2(x.usd), kzt: r2(x.kzt) }));
        out.push({ month: m, dealer, platform, date_to: to, conv: r2(conv), usd: r2(usd), kzt: r2(kzt), camps: JSON.stringify(camps), at });
      }
    }
    const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1));
    m = d.toISOString().slice(0, 7);
  }
  return out;
}

/**
 * Сверка D1 с кабинетами за месяц по дилеру: строки cc_gaps (ads_* — числа кабинета).
 * @param cab        строки cc_cabinet дилера за месяц
 * @param d1         строки D1 дилера за месяц [{Platform, Date, c, cv, usd, kzt}] (d1Month в etl/gaps.mjs)
 * @param expectEnd  по какую дату кабинет должен быть прочитан: min(конец месяца, вчера)
 */
export function buildCabinetGaps(cab, d1, expectEnd) {
  const plats = [...new Set([...cab.map((c) => c.platform), ...d1.map((r) => r.Platform)])].filter((p) => SPEND_CUR[p]);
  const out = [];
  for (const p of plats) {
    const c = cab.find((x) => x.platform === p);
    const cur = SPEND_CUR[p];
    if (!c) {
      // кабинет ещё ни разу не прочитан целиком за месяц — сравнивать не с чем (не ошибка: появится после ближайшей выгрузки)
      const rows = d1.filter((r) => r.Platform === p);
      out.push({ platform: p, ads_conv: null, d1_conv: rows.reduce((s, r) => s + r.cv, 0), gap: 0, ads_spend: null,
        d1_spend: r2(rows.reduce((s, r) => s + (cur === 'KZT' ? r.kzt : r.usd), 0)), spend_cur: cur, spend_ok: null, no_hub: 1,
        ads_date: null, cap_date: null, camps: null, error: null, cab_at: null, stale: 0 });
      continue;
    }
    const rows = d1.filter((r) => r.Platform === p && r.Date <= c.date_to);
    const by = {};
    let conv = 0; let sp = 0;
    for (const r of rows) {
      const v = cur === 'KZT' ? r.kzt : r.usd;
      const x = (by[r.c] = by[r.c] || { b: 0, sb: 0 });
      x.b += r.cv; x.sb += v; conv += r.cv; sp += v;
    }
    const cabSp = cur === 'KZT' ? c.kzt : c.usd;
    const gap = Math.round(c.conv - conv);
    const sok = spendOk(cabSp, sp, cur);
    let camps = null;
    if (gap !== 0 || !sok) {
      let list = (JSON.parse(c.camps || '[]') || []).map((x) => {
        const g = by[x.n] || { b: 0, sb: 0 }; delete by[x.n];
        return { n: x.n, a: x.cv, b: r2(g.b), sa: cur === 'KZT' ? x.kzt : x.usd, sb: r2(g.sb) };
      });
      for (const [n, g] of Object.entries(by)) list.push({ n, a: 0, b: r2(g.b), sa: 0, sb: r2(g.sb), x: 1 }); // есть в D1, нет в кабинете
      list = list.filter((o) => Math.abs(Math.round(o.a - o.b)) >= 1 || !spendOk(o.sa, o.sb, cur));
      list.sort((q, w) => Math.abs(w.a - w.b) - Math.abs(q.a - q.b) || Math.abs(w.sa - w.sb) - Math.abs(q.sa - q.sb));
      camps = JSON.stringify(list.slice(0, 20));
    }
    out.push({ platform: p, ads_conv: c.conv, d1_conv: r2(conv), gap, ads_spend: r2(cabSp), d1_spend: r2(sp), spend_cur: cur,
      spend_ok: sok ? 1 : 0, no_hub: 0, ads_date: c.date_to, cap_date: c.date_to, camps, error: null, cab_at: c.at, stale: c.date_to < expectEnd ? 1 : 0 });
  }
  return out;
}
