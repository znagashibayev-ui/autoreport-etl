// Google Ads — перенос 1:1 из Apps Script runGoogleAdsETL_ForceReload (Force_load_Google.gs): его вызывает ночной
// ре-синк, он и определяет итог в BigQuery. Вместе с ним — хук месячного эталона Google_HubRules.gs (ghrApplyHubEtalon_:
// конверсии по целям из Registry Autoreport Hub + ручные фиксы вкладки Overrides).
//
// Ключи приложения Google (OAuth client id/secret, developer token) — секреты GitHub, в коде их нет.
//
// Намеренные отличия от оригинала:
//   1. Ошибка API (нет access_token, ошибка дневного запроса) останавливает только этого дилера, старые данные в базе
//      не трогаются. Оригинал к этому моменту уже удалил срез дилера в BigQuery.
//   2. Ответ читается целиком (nextPageToken). Оригинал брал только первую страницу (10 000 строк на запрос).
//   3. Повтор при сбое сети / 5xx / лимите запросов (429). Ошибки месячного эталона, как в оригинале, его пропускают —
//      и попадают в итог запуска.

import { detectMarketingObjective, parseCampaignName, pickModelFieldWaterfall } from '../lib/classify.mjs';
import { registerKeep } from './meta.mjs';

const API = 'https://googleads.googleapis.com/v24/customers/';
export const GOOGLE_LOGIN_CUSTOMER_ID = '5297548449'; // MCC
export const HUB_ID = '16N9XPIWTnkMAu41kPQg-byRe9kYM2NDx-elQh8DOAak'; // Autoreport Hub (MG_HUB_ID)
const JUNK_WORDS = ['подписк', 'subscri', 'youtube', 'просмотр', 'pageview'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isJunkCampaign = (n) => { const l = n.toLowerCase(); return l.indexOf('youtube') > -1 || l.indexOf('_yt') > -1 || l.indexOf('-yt') > -1 || l.indexOf('подписк') > -1 || l.indexOf('subscri') > -1; };

/** Месяцы окна, начало обрезано до startDate, конец — до endDate (как monthsList в оригинале). */
export function monthsOf(startDate, endDate) {
  const out = [];
  let y = Number(startDate.slice(0, 4)); let m = Number(startDate.slice(5, 7));
  for (;;) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mFrom = `${y}-${mm}-01`;
    if (mFrom > endDate) break;
    let mTo = `${y}-${mm}-${String(last).padStart(2, '0')}`;
    if (mTo > endDate) mTo = endDate;
    out.push({ key: `${y}-${mm}`, from: mFrom < startDate ? startDate : mFrom, to: mTo });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/* ===================== Hub: Registry и Overrides (Google_HubRules.gs) ===================== */

const ghrList = (v) => String(v === null || v === undefined ? '' : v).split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const ghrNorm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function ghrFindKey(obj, name) {
  const want = ghrNorm(name);
  for (const k in obj) if (ghrNorm(k) === want) return k;
  return null;
}
const ghrDays = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000) + 1;

/** mgCellDate_: дата ячейки → 'yyyy-MM-dd'. Sheets API отдаёт даты серийными номерами (как getValues — Date). */
export function cellDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10) : '';
  const s = String(v).trim();
  const m1 = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m1) return m1[3] + '-' + (m1[2].length < 2 ? '0' : '') + m1[2] + '-' + (m1[1].length < 2 ? '0' : '') + m1[1];
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m2 ? m2[1] + '-' + m2[2] + '-' + m2[3] : '';
}

/** Лист Registry → { dealer_id в нижнем регистре: {ids, inc, exc} } (ghrRegistryFor_; алиасов MG_FX2_ALIASES нет). */
export function parseHubRegistry(values) {
  const memo = {};
  if (!values || !values.length) return memo;
  const head = values[0].map((h) => String(h).trim().toLowerCase());
  const cId = head.indexOf('dealer_id'); const cInc = head.indexOf('google_conv_include'); const cExc = head.indexOf('google_conv_exclude');
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const rid = String(row[cId] || '').trim();
    if (!rid) continue;
    const rec = { ids: [rid.toLowerCase()], inc: cInc >= 0 ? ghrList(row[cInc]) : [], exc: cExc >= 0 ? ghrList(row[cExc]) : [] };
    for (const x of rec.ids) if (!memo[x]) memo[x] = rec;
  }
  return memo;
}

/** Лист Overrides → фиксы Google (ghrOverridesFor_ без фильтра по дилеру). */
export function parseHubOverrides(values) {
  const out = [];
  for (let i = 1; i < (values || []).length; i++) {
    const v = values[i] || [];
    const o = {
      dealer: String(v[0] || '').trim().toLowerCase(), platform: String(v[1] || '').trim().toLowerCase(),
      campaign: String(v[2] || '').trim(), from: cellDate(v[3]), to: cellDate(v[4]),
      conv: Number(String(v[5]).replace(',', '.')) || 0
    };
    if (!o.dealer || !o.campaign || !o.from || !o.to || o.from > o.to) continue;
    if (o.platform && o.platform !== 'google' && o.platform !== 'google ads') continue;
    out.push(o);
  }
  return out;
}

/* ===================== Запросы ===================== */

async function postJson(url, init, fetchImpl, retryMs) {
  for (let attempt = 0; ; attempt++) {
    let res; let json;
    try {
      res = await fetchImpl(url, init);
      json = await res.json();
    } catch (err) {
      if (attempt >= 3) throw new Error('нет связи с Google: ' + err.message);
      await sleep(retryMs * 2 ** attempt);
      continue;
    }
    if (res.status >= 500 && attempt < 3) { await sleep(retryMs * 2 ** attempt); continue; }
    // лимит запросов (RESOURCE_EXHAUSTED): дольше и чаще — по подсказке Google «retryDelay», не больше минуты за раз
    if (res.status === 429 && attempt < 5) {
      const hint = JSON.stringify(json || {}).match(/"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/);
      // ждать больше минуты — исчерпан дневной лимит developer token: повторы лишь вешали ночную выгрузку на 5 мин на дилера
      if (hint && Number(hint[1]) > 60) throw new Error(`RESOURCE_EXHAUSTED: дневной лимит Google Ads API исчерпан, Google просит подождать ${Math.ceil(Number(hint[1]) / 60)} мин`);
      await sleep(Math.min(60000, Math.max(retryMs * 3 ** (attempt + 1), hint ? Number(hint[1]) * 1000 : 0)));
      continue;
    }
    return json;
  }
}

/** access_token по refresh token дилера (getValidGoogleToken). null — не выдан. */
export async function googleAccessToken(refreshToken, keys, fetchImpl = fetch, retryMs = 2000) {
  const body = new URLSearchParams({ client_id: keys.clientId, client_secret: keys.clientSecret, refresh_token: String(refreshToken), grant_type: 'refresh_token' });
  const j = await postJson('https://oauth2.googleapis.com/token', { method: 'POST', body }, fetchImpl, retryMs);
  return j.access_token || null;
}

/**
 * Строки daily_statistics одного аккаунта Google Ads за период — до пересчёта курсов, отсева пустых строк и обнуления Awareness.
 * @param {{dealerId: string, customerId: string, token: string, dealerType: string, startDate: string, endDate: string,
 *          dicts: object, keys: {clientId: string, clientSecret: string, developerToken: string},
 *          hub?: {registry: object, overrides: object[]}, keep?: object, warn?: (s: string) => void,
 *          onChunk?: () => void, fetchImpl?: typeof fetch, retryMs?: number}} o
 */
export async function googleDealerRows(o) {
  const { dealerId, startDate, endDate, dicts, keys } = o;
  const keep = o.keep || {};
  const warn = o.warn || (() => {});
  const tick = () => { if (o.onChunk) o.onChunk(); };
  const fetchImpl = o.fetchImpl || fetch;
  const retryMs = o.retryMs ?? 2000;
  const customerId = String(o.customerId).replace(/-/g, '');
  const dealerType = o.dealerType || 'Не указан';
  const label = `Google Ads [${dealerId} / ${customerId}]`;

  const accessToken = await googleAccessToken(o.token, keys, fetchImpl, retryMs);
  if (!accessToken) throw new Error(`${label}: нет access_token (refresh token недействителен или отозван)`);
  const url = API + customerId + '/googleAds:search';
  const headers = { Authorization: 'Bearer ' + accessToken, 'developer-token': keys.developerToken, 'login-customer-id': GOOGLE_LOGIN_CUSTOMER_ID, 'Content-Type': 'application/json' };
  /** Все страницы запроса: {results} или {error}. */
  async function search(query) {
    let results = []; let pageToken = null;
    for (;;) {
      const j = await postJson(url, { method: 'POST', headers, body: JSON.stringify(pageToken ? { query, pageToken } : { query }) }, fetchImpl, retryMs);
      // кабинет не под MCC, но владелец токена имеет к нему прямой доступ — дальше этот кабинет читается без MCC
      if (j.error && !pageToken && headers['login-customer-id'] && /does not have permission/i.test(String(j.error.message))) {
        delete headers['login-customer-id'];
        warn(`ℹ️ ${label}: кабинет не под MCC ${GOOGLE_LOGIN_CUSTOMER_ID} — читается напрямую по доступу владельца токена.`);
        continue;
      }
      if (j.error) return { error: String(j.error.message || JSON.stringify(j.error)).slice(0, 300) };
      if (j.results) results = results.concat(j.results);
      pageToken = j.nextPageToken || null;
      if (!pageToken) return { results };
    }
  }
  const between = (f, t) => "segments.date BETWEEN '" + f + "' AND '" + t + "'";

  const totalsByCamp = {}; const allocatedByCamp = {}; const aggregatedData = {}; const validCamps = {};
  async function executeQuery(gaql, isConversionQuery, isAdLevel) {
    gaql = gaql.replace('segments.conversion_action_name, ', ''); // как в оригинале: без сегментации, чтобы API не прятал PMax-лиды
    const r = await search(gaql);
    if (r.error) {
      const e = new Error(`${label}: ${r.error}`);
      // аккаунт не привязан к MCC (или доступ отозван) — Apps Script с тем же доступом его тоже не грузит
      e.noAccess = /caller does not have permission|USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED/i.test(r.error);
      throw e;
    }
    for (const row of r.results) {
      const date = row.segments.date; const cName = row.campaign.name;
      const dateCampKey = date + '|||' + cName;
      let impr = parseInt(row.metrics.impressions) || 0; let clicks = parseInt(row.metrics.clicks) || 0;
      let cost = parseFloat(row.metrics.costMicros) || 0.0; let convs = parseFloat(row.metrics.conversions) || 0.0;
      if (isJunkCampaign(cName)) convs = 0.0;
      if (isConversionQuery && row.segments && row.segments.conversionActionName) {
        const actionName = row.segments.conversionActionName.toLowerCase();
        if (JUNK_WORDS.some((w) => actionName.includes(w))) convs = 0.0;
        impr = 0; clicks = 0; cost = 0.0;
      }
      if (!isAdLevel) {
        if (!isConversionQuery) validCamps[cName] = true;
        const t = (totalsByCamp[dateCampKey] = totalsByCamp[dateCampKey] || { date, cName, impr: 0, clicks: 0, cost: 0.0, convs: 0.0 });
        t.impr += impr; t.clicks += clicks; t.cost += cost; t.convs += convs;
      } else {
        const agName = row.adGroup ? row.adGroup.name : '';
        const adName = row.adGroupAd && row.adGroupAd.ad ? row.adGroupAd.ad.name || '' : '';
        const wf = pickModelFieldWaterfall(cName, agName, adName, dealerId, dicts);
        const finalName = wf.field === 'camp' ? cName : wf.field === 'ag' ? cName + '_' + agName : wf.field === 'ad' ? cName + '_' + adName : cName + '_another';
        const fk = date + '|||' + finalName;
        const a = (aggregatedData[fk] = aggregatedData[fk] || { date, name: finalName, origCName: cName, impr: 0, clicks: 0, cost: 0.0, convs: 0.0 });
        a.impr += impr; a.clicks += clicks; a.cost += cost; a.convs += convs;
        const b = (allocatedByCamp[dateCampKey] = allocatedByCamp[dateCampKey] || { impr: 0, clicks: 0, cost: 0.0, convs: 0.0 });
        b.impr += impr; b.clicks += clicks; b.cost += cost; b.convs += convs;
      }
    }
  }

  const w = between(startDate, endDate);
  await executeQuery('SELECT segments.date, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE ' + w + ' AND metrics.impressions > 0', false, false);
  await executeQuery('SELECT segments.date, campaign.name, segments.conversion_action_name, metrics.conversions FROM campaign WHERE ' + w + ' AND metrics.conversions > 0', true, false);
  tick();
  await executeQuery('SELECT segments.date, campaign.name, ad_group.name, ad_group_ad.ad.name, metrics.impressions, metrics.clicks, metrics.cost_micros FROM ad_group_ad WHERE ' + w + ' AND metrics.impressions > 0', false, true);
  await executeQuery('SELECT segments.date, campaign.name, ad_group.name, ad_group_ad.ad.name, segments.conversion_action_name, metrics.conversions FROM ad_group_ad WHERE ' + w + ' AND metrics.conversions > 0', true, true);
  tick();

  // Тип кампании (SEARCH / PERFORMANCE_MAX / …) — подсказка для цели, ошибка не мешает выгрузке
  const campaignChannelTypes = {};
  const ct = await search('SELECT campaign.name, campaign.advertising_channel_type FROM campaign WHERE ' + w);
  if (ct.error) warn(`⚠️ ${label}: не удалось получить channel_type: ${ct.error}`);
  for (const cR of ct.results || []) if (cR.campaign && cR.campaign.name) campaignChannelTypes[cR.campaign.name] = cR.campaign.advertisingChannelType || '';

  // Месячный эталон
  const monthlyConvByCamp = {};
  const monthsList = monthsOf(startDate, endDate);
  for (const mInfo of monthsList) {
    const r = await search('SELECT campaign.name, metrics.conversions FROM campaign WHERE ' + between(mInfo.from, mInfo.to) + ' AND metrics.conversions > 0');
    if (r.error) { warn(`⚠️ ${label}: месячный эталон ${mInfo.key} не получен (${r.error}) — конверсии месяца без сверки, как в Apps Script`); continue; }
    const rawByCamp = {};
    for (const crow of r.results) {
      const actionName = crow.segments && crow.segments.conversionActionName ? crow.segments.conversionActionName.toLowerCase() : '';
      if (JUNK_WORDS.some((x) => actionName.indexOf(x) !== -1)) continue;
      let cv = parseFloat(crow.metrics.conversions) || 0.0;
      if (isJunkCampaign(crow.campaign.name)) cv = 0.0;
      rawByCamp[crow.campaign.name] = (rawByCamp[crow.campaign.name] || 0.0) + cv;
    }
    for (const cKey in rawByCamp) monthlyConvByCamp[mInfo.key + '|||' + cKey] = Math.round(rawByCamp[cKey]);
  }

  // YouTube: вместо нуля — только submit_form_all (дневные и месячный эталон)
  if (Object.keys(validCamps).some((vc) => /yt|youtube/i.test(vc))) {
    const conv = (f, t, dated) => search('SELECT ' + (dated ? 'segments.date, ' : '') + 'campaign.name, segments.conversion_action_name, metrics.conversions FROM campaign WHERE ' + between(f, t) + ' AND metrics.conversions > 0');
    const yd = await conv(startDate, endDate, true);
    if (yd.error) warn(`⚠️ ${label}: YouTube submit_form_all: ${yd.error}`);
    for (const ydRow of yd.results || []) {
      const n = ydRow.campaign.name;
      if (!/yt|youtube/i.test(n)) continue;
      const action = ydRow.segments && ydRow.segments.conversionActionName ? ydRow.segments.conversionActionName.toLowerCase() : '';
      if (action.indexOf('submit_form_all') === -1) continue;
      const k = ydRow.segments.date + '|||' + n;
      if (totalsByCamp[k]) totalsByCamp[k].convs += parseFloat(ydRow.metrics.conversions) || 0.0;
    }
    for (const ym of monthsList) {
      const r = await conv(ym.from, ym.to, false);
      if (!r.results) continue;
      const byCamp = {};
      for (const row of r.results) {
        const n = row.campaign.name;
        if (!/yt|youtube/i.test(n)) continue;
        const action = row.segments && row.segments.conversionActionName ? row.segments.conversionActionName.toLowerCase() : '';
        if (action.indexOf('submit_form_all') === -1) continue;
        byCamp[n] = (byCamp[n] || 0.0) + (parseFloat(row.metrics.conversions) || 0.0);
      }
      for (const n in byCamp) monthlyConvByCamp[ym.key + '|||' + n] = Math.round(byCamp[n]);
    }
  }

  // ENGAGEMENT / YOUTUBE-категории конверсий — вычитаются из дневных и из эталона
  {
    const cat = (row) => (row.segments && row.segments.conversionActionCategory ? row.segments.conversionActionCategory.toString().toUpperCase() : '');
    const isEng = (c) => c.indexOf('ENGAGEMENT') !== -1 || c.indexOf('YOUTUBE') !== -1;
    const ed = await search('SELECT segments.date, campaign.name, segments.conversion_action_category, metrics.conversions FROM campaign WHERE ' + w + ' AND metrics.conversions > 0');
    if (ed.error) warn(`⚠️ ${label}: ENGAGEMENT-фильтр: ${ed.error}`);
    for (const row of ed.results || []) {
      if (!isEng(cat(row))) continue;
      const k = row.segments.date + '|||' + row.campaign.name;
      if (totalsByCamp[k]) totalsByCamp[k].convs = Math.max(0, totalsByCamp[k].convs - (parseFloat(row.metrics.conversions) || 0.0));
    }
    for (const em of monthsList) {
      const r = await search('SELECT campaign.name, segments.conversion_action_category, metrics.conversions FROM campaign WHERE ' + between(em.from, em.to) + ' AND metrics.conversions > 0');
      if (!r.results) continue;
      const byCamp = {};
      for (const row of r.results) {
        if (!isEng(cat(row))) continue;
        byCamp[row.campaign.name] = (byCamp[row.campaign.name] || 0.0) + (parseFloat(row.metrics.conversions) || 0.0);
      }
      for (const n in byCamp) {
        const k = em.key + '|||' + n;
        if (monthlyConvByCamp[k] !== undefined) monthlyConvByCamp[k] = Math.max(0, monthlyConvByCamp[k] - Math.round(byCamp[n]));
      }
    }
  }
  tick();

  // Остатки кампании (не разнесённые по объявлениям) — под оригинальным именем кампании
  for (const key of Object.keys(totalsByCamp)) {
    const t = totalsByCamp[key];
    if (!validCamps[t.cName]) continue;
    const a = allocatedByCamp[key] || { impr: 0, clicks: 0, cost: 0.0, convs: 0.0 };
    const remImpr = Math.max(0, t.impr - a.impr); const remClicks = Math.max(0, t.clicks - a.clicks);
    let remCost = t.cost - a.cost; if (remCost < 0.01) remCost = 0.0;
    let remConvs = t.convs - a.convs; if (remConvs < 0.01) remConvs = 0.0;
    if (remImpr > 0 || remCost > 0.0 || remConvs > 0.0) {
      const rk = t.date + '|||' + t.cName;
      const r = (aggregatedData[rk] = aggregatedData[rk] || { date: t.date, name: t.cName, origCName: t.cName, impr: 0, clicks: 0, cost: 0.0, convs: 0.0 });
      r.impr += remImpr; r.clicks += remClicks; r.cost += remCost; r.convs += remConvs;
    }
  }

  const dealerRows = [];
  for (const k of Object.keys(aggregatedData)) {
    const agg = aggregatedData[k];
    const spendUSD = agg.cost / 1000000;
    const parsed = parseCampaignName(agg.name, dealerId, dicts);
    const low = agg.name.toLowerCase();
    const origCampName = agg.origCName || agg.name.replace(/_another$/, '');
    let objective = detectMarketingObjective(agg.name, campaignChannelTypes[origCampName]);
    if (objective === 'Another') objective = parsed.objective;
    let type = parsed.type;
    if (/smartgdn/i.test(low)) type = 'Smart Google Display Network';
    else if (/gdn/i.test(low)) type = 'Google Display Network';
    else if (/dgen/i.test(low)) type = 'Demand Gen';
    else if (/search/i.test(low)) type = 'Search';
    else if (/pmax/i.test(low)) type = 'Performance Max';
    else if (/yt|youtube/i.test(low)) type = 'Youtube';
    else if (/epk/i.test(low)) type = 'Единые перформанс кампании';
    else if (/rsy/i.test(low)) type = 'Рекламная Сеть Яндекса';
    dealerRows.push({
      Date: agg.date, Platform: 'Google Ads', Dealer_ID: dealerId, Dealer_Type: dealerType, Campaign_Name: agg.name, _origCName: agg.origCName || agg.name,
      // Spend_KZT пересчитает applyRates по курсу из D1 (натив = Spend_USD, сумма API в валюте аккаунта)
      Impressions: Math.round(agg.impr), Reach: 0, Clicks: Math.round(agg.clicks), Conversions: Math.round(agg.convs), Spend_KZT: spendUSD * 450, Spend_USD: spendUSD,
      Marketing_Objective: objective, Campaign_Type: type, Car_Brand: parsed.brand, Car_Model: parsed.model
    });
  }

  await applyHubEtalon(monthlyConvByCamp, monthsList, search, dealerId, o.hub, keep, warn);

  // Подгонка конверсий под месячный эталон: перебор снимается с последних дней, недостача — в последний день
  const groupSums = {};
  for (const r of dealerRows) {
    const gk = r.Date.substring(0, 7) + '|||' + r._origCName.replace(/_another$/, '');
    groupSums[gk] = (groupSums[gk] || 0) + r.Conversions;
  }
  for (const gk in groupSums) {
    const monthlyTrue = monthlyConvByCamp[gk];
    if (monthlyTrue === undefined) continue;
    let diff = monthlyTrue - groupSums[gk];
    if (diff === 0) continue;
    const indices = [];
    for (let ri = 0; ri < dealerRows.length; ri++) {
      if (dealerRows[ri].Date.substring(0, 7) + '|||' + dealerRows[ri]._origCName.replace(/_another$/, '') === gk) indices.push(ri);
    }
    if (indices.length === 0 && diff > 0) {
      // конверсии без строк с показами — строка на 1-е число месяца, чтобы разница не пропала
      const [monthPrefix, cNameOnly] = gk.split('|||');
      const p = parseCampaignName(cNameOnly, dealerId, dicts);
      dealerRows.push({ Date: monthPrefix + '-01', Platform: 'Google Ads', Dealer_ID: dealerId, Dealer_Type: dealerType, Campaign_Name: cNameOnly, _origCName: cNameOnly,
        Impressions: 0, Reach: 0, Clicks: 0, Conversions: diff, Spend_KZT: 0, Spend_USD: 0,
        Marketing_Objective: detectMarketingObjective(cNameOnly, ''), Campaign_Type: p.type, Car_Brand: p.brand, Car_Model: p.model });
      diff = 0;
    }
    indices.sort((a, b) => (dealerRows[a].Date < dealerRows[b].Date ? 1 : -1)); // тот же компаратор, что в оригинале (порядок равных дат)
    for (const idx of indices) {
      if (diff === 0) break;
      if (diff > 0) { dealerRows[idx].Conversions += diff; diff = 0; } else if (dealerRows[idx].Conversions >= Math.abs(diff)) { dealerRows[idx].Conversions += diff; diff = 0; } else { diff += dealerRows[idx].Conversions; dealerRows[idx].Conversions = 0; }
    }
  }
  for (const r of dealerRows) delete r._origCName;
  return dealerRows;
}

/** ghrApplyHubEtalon_: эталон по целям Hub + ручные фиксы. Любая ошибка — эталон (с уже применёнными месяцами) остаётся, как в оригинале. */
async function applyHubEtalon(monthlyConvByCamp, monthsList, search, dealerId, hub, keep, warn) {
  try {
    if (!hub) return;
    const cfg = hub.registry[String(dealerId || '').trim().toLowerCase()];
    if (!cfg) return; // дилера нет в Registry Hub — эталон по прежним правилам ETL
    const ovs = hub.overrides.filter((ov) => cfg.ids.indexOf(ov.dealer) > -1);
    const cache = {};
    const sum = async (from, to) => {
      const ck = from + '|' + to;
      if (!cache[ck]) {
        const r = await search("SELECT campaign.name, campaign.status, segments.conversion_action_name, metrics.conversions FROM campaign WHERE segments.date BETWEEN '" + from + "' AND '" + to + "' AND metrics.conversions > 0");
        if (r.error) throw new Error('Google Ads API: ' + r.error);
        const out = {};
        for (const row of r.results) {
          const name = ((row.campaign && row.campaign.name) || '').trim();
          if (!name || (row.campaign && row.campaign.status === 'REMOVED')) continue;
          const action = String((row.segments && row.segments.conversionActionName) || '').toLowerCase();
          let ok = cfg.inc.length === 0 || cfg.inc.some((s) => action.indexOf(s) > -1);
          if (ok && cfg.exc.some((s) => action.indexOf(s) > -1)) ok = false;
          if (!ok) continue;
          out[name] = (out[name] || 0) + (parseFloat(row.metrics && row.metrics.conversions) || 0);
        }
        cache[ck] = out;
      }
      return { ...cache[ck] };
    };
    for (const mi of monthsList) {
      const h = await sum(mi.from, mi.to);
      for (const ov of ovs) {
        const from = ov.from > mi.from ? ov.from : mi.from;
        const to = ov.to < mi.to ? ov.to : mi.to;
        if (from > to) continue;
        const part = await sum(from, to);
        const pKey = ghrFindKey(part, ov.campaign);
        const apiPart = pKey ? part[pKey] : 0;
        let share = 1;
        if (from !== ov.from || to !== ov.to) {
          const full = await sum(ov.from, ov.to);
          const fKey = ghrFindKey(full, ov.campaign);
          const apiFull = fKey ? full[fKey] : 0;
          share = apiFull > 0 ? apiPart / apiFull : ghrDays(from, to) / ghrDays(ov.from, ov.to);
        }
        const key = ghrFindKey(h, ov.campaign) || pKey;
        if (!key) continue;
        h[key] = Math.max(0, (h[key] || 0) - apiPart + ov.conv * share);
      }
      const prefix = mi.key + '|||';
      for (const k of Object.keys(monthlyConvByCamp)) {
        if (k.indexOf(prefix) !== 0) continue;
        if (Object.prototype.hasOwnProperty.call(h, k.substring(prefix.length))) continue;
        monthlyConvByCamp[k] = 0;
      }
      for (const nm of Object.keys(h)) {
        const v = Math.round(h[nm]);
        monthlyConvByCamp[prefix + nm] = v;
        if (v > 0) registerKeep(keep, dealerId, nm);
      }
    }
  } catch (e) {
    if (/RESOURCE_EXHAUSTED/.test(e.message)) throw e; // дневной лимит — дилер падает целиком, а не пишется без эталона
    warn(`❌ GHR [${dealerId}]: ${e.message} — эталон Google оставлен по прежним правилам ETL`);
  }
}
