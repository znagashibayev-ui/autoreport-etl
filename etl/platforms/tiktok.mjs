// TikTok — перенос 1:1 из Apps Script runTikTokETL_ForceReload (Force_load_TikTok.gs): его вызывает ночной
// ре-синк, он и определяет итог в BigQuery. Ночной runTikTokETL (3_OtherPlatforms_Engines.gs) считает так же.
//
// Намеренные отличия от оригинала:
//   1. Ошибка API (code ≠ 0, сбой сети) останавливает только этого дилера, его старые данные в базе не трогаются.
//      Оригинал пропускал кусок отчёта молча и уже успел удалить срез дилера в BigQuery.
//   2. Отчёт читается целиком, все страницы. Оригинал брал только первую (1000 строк на кусок в 30 дней).
//   3. Повтор при сбое сети / 5xx / лимите запросов (оригинал не повторял).

import { detectMarketingObjective, parseCampaignName, pickModelFieldWaterfall } from '../lib/classify.mjs';

const API = 'https://business-api.tiktok.com/open_api/v1.3/';
const RETRY_CODES = new Set([40100, 50000, 50002]); // лимит запросов и временные ошибки сервера TikTok
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Куски по 30 дней включительно, как fetchTTChunked: [start, start+29], затем со следующего дня. */
export function chunkDates30(startDate, endDate) {
  const out = [];
  for (let cur = startDate; cur <= endDate;) {
    let end = addDays(cur, 29);
    if (end > endDate) end = endDate;
    out.push([cur, end]);
    cur = addDays(end, 1);
  }
  return out;
}

async function getJson(url, token, fetchImpl, retryMs) {
  for (let attempt = 0; ; attempt++) {
    let res; let json;
    try {
      res = await fetchImpl(url, { headers: { 'Access-Token': token } });
      json = await res.json();
    } catch (err) {
      if (attempt >= 3) throw new Error('нет связи с TikTok API: ' + err.message);
      await sleep(retryMs * 2 ** attempt);
      continue;
    }
    if ((res.status >= 500 || RETRY_CODES.has(json.code)) && attempt < 3) {
      await sleep(retryMs * 2 ** attempt);
      continue;
    }
    return json;
  }
}

/**
 * Строки daily_statistics одного кабинета за период — до пересчёта курсов, отсева пустых строк и обнуления Awareness.
 * @param {{dealerId: string, advId: string, token: string, startDate: string, endDate: string, dicts: object,
 *          fetchImpl?: typeof fetch, retryMs?: number}} o
 */
export async function tiktokDealerRows(o) {
  const { dealerId, token, startDate, endDate, dicts } = o;
  const advId = String(o.advId);
  const fetchImpl = o.fetchImpl || fetch;
  const retryMs = o.retryMs ?? 2000;

  // objective_type кампаний; как в оригинале, без него выгрузка продолжается (цель — по имени)
  const campaignObjectives = {};
  try {
    const base = API + 'campaign/get/?advertiser_id=' + advId + '&fields=' +
      encodeURIComponent(JSON.stringify(['campaign_id', 'campaign_name', 'objective_type'])) + '&page_size=1000';
    for (let page = 1; ; page++) {
      const r = await getJson(base + '&page=' + page, token, fetchImpl, retryMs);
      if (r.code !== 0 || !r.data || !r.data.list) break;
      for (const c of r.data.list) if (c.campaign_name) campaignObjectives[c.campaign_name] = c.objective_type || '';
      if (page >= ((r.data.page_info || {}).total_page || 1)) break;
    }
  } catch { /* как в оригинале: только лог */ }

  async function fetchChunked(level, dims, metrics) {
    let all = [];
    for (const [from, to] of chunkDates30(startDate, endDate)) {
      const base = API + 'report/integrated/get/?advertiser_id=' + advId + '&report_type=BASIC&data_level=' + level +
        '&dimensions=' + encodeURIComponent(JSON.stringify(dims)) + '&metrics=' + encodeURIComponent(JSON.stringify(metrics)) +
        '&start_date=' + from + '&end_date=' + to + '&page_size=1000';
      for (let page = 1; ; page++) {
        const r = await getJson(page === 1 ? base : base + '&page=' + page, token, fetchImpl, retryMs);
        if (r.code !== 0) throw new Error(`TikTok API [${dealerId} / ${advId}] code=${r.code}: ${r.message || 'без описания'} (${level}, ${from} — ${to})`);
        if (!r.data || !r.data.list) break;
        all = all.concat(r.data.list);
        if (page >= ((r.data.page_info || {}).total_page || 1)) break;
      }
      if (o.onChunk) o.onChunk(); // прогресс выгрузки для админки
    }
    return all;
  }

  const totalsByCamp = {};
  const allocatedByCamp = {};
  const aggregatedData = {};
  const zero = () => ({ impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 });
  const metricsList = ['campaign_name', 'spend', 'impressions', 'clicks', 'engagements', 'reach', 'conversion'];

  for (const row of await fetchChunked('AUCTION_CAMPAIGN', ['stat_time_day', 'campaign_id'], metricsList)) {
    const date = row.dimensions.stat_time_day.split(' ')[0];
    const m = row.metrics;
    const cName = m.campaign_name || '';
    const k = date + '|||' + cName;
    const t = (totalsByCamp[k] = totalsByCamp[k] || { date, cName, ...zero() });
    t.impr += parseInt(m.impressions) || 0;
    t.reach += parseInt(m.reach) || 0;
    t.clicks += parseInt(m.engagements) || parseInt(m.clicks) || 0;
    t.cost += parseFloat(m.spend) || 0;
    t.convs += parseFloat(m.conversion) || 0;
  }

  for (const row of await fetchChunked('AUCTION_AD', ['stat_time_day', 'ad_id'], metricsList.concat(['adgroup_name', 'ad_name']))) {
    const date = row.dimensions.stat_time_day.split(' ')[0];
    const m = row.metrics;
    const cName = m.campaign_name || '';
    const asName = m.adgroup_name || '';
    const adName = m.ad_name || '';
    const wf = pickModelFieldWaterfall(cName, asName, adName, dealerId, dicts);
    const finalName = wf.field === 'camp' ? cName : wf.field === 'ag' ? cName + '_' + asName : wf.field === 'ad' ? cName + '_' + adName : cName + '_another';
    const fKey = date + '|||' + finalName;
    const campKey = date + '|||' + cName;
    const clicks = parseInt(m.engagements) || parseInt(m.clicks) || 0;
    const a = (aggregatedData[fKey] = aggregatedData[fKey] || { date, name: finalName, origCName: cName, ...zero() });
    const b = (allocatedByCamp[campKey] = allocatedByCamp[campKey] || zero());
    for (const x of [a, b]) {
      x.impr += parseInt(m.impressions) || 0;
      x.reach += parseInt(m.reach) || 0;
      x.clicks += clicks;
      x.cost += parseFloat(m.spend) || 0;
      x.convs += parseFloat(m.conversion) || 0;
    }
  }

  // Остаток кампании (итог минус разнесённое по объявлениям) — всегда под оригинальным именем кампании.
  for (const k of Object.keys(totalsByCamp)) {
    const t = totalsByCamp[k];
    const alloc = allocatedByCamp[k] || zero();
    const rImpr = Math.max(0, t.impr - alloc.impr);
    const rCost = Math.max(0, t.cost - alloc.cost);
    const rConvs = Math.max(0, t.convs - alloc.convs);
    const rClicks = Math.max(0, t.clicks - alloc.clicks);
    if (rImpr > 0 || rCost > 0 || rConvs > 0 || rClicks > 0) {
      const remKey = t.date + '|||' + t.cName;
      const r = (aggregatedData[remKey] = aggregatedData[remKey] || { date: t.date, name: t.cName, origCName: t.cName, ...zero() });
      r.impr += rImpr; r.reach += Math.max(0, t.reach - alloc.reach); r.clicks += rClicks; r.cost += rCost; r.convs += rConvs;
    }
  }

  const rows = [];
  for (const key of Object.keys(aggregatedData)) {
    const agg = aggregatedData[key];
    const parsed = parseCampaignName(agg.name, dealerId, dicts);
    let goal = detectMarketingObjective(agg.name, campaignObjectives[agg.origCName || agg.name]);
    if (goal === 'Another') goal = parsed.objective;
    rows.push({
      Date: agg.date, Platform: 'TikTok', Dealer_ID: dealerId, Dealer_Type: dealerId.includes('Distributor') ? 'Дистрибьютор' : 'Дилер',
      Campaign_Name: agg.name, Impressions: agg.impr, Reach: agg.reach, Clicks: agg.clicks, Conversions: Math.round(agg.convs),
      // Spend_KZT пересчитает applyRates по курсу из D1 (валюта кабинета USD → натив = Spend_USD)
      Spend_KZT: agg.cost * 450, Spend_USD: agg.cost, Marketing_Objective: goal, Campaign_Type: parsed.type,
      Car_Brand: parsed.brand, Car_Model: parsed.model
    });
  }
  return rows;
}
