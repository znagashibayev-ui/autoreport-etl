// Яндекс.Директ — перенос 1:1 из Apps Script runYandexETL_ForceReload (Force_load_Yandex.gs),
// той же логики, что и ночной runYandexETL (3_OtherPlatforms_Engines.gs) без проверки «уже загружено».
//
// Отличие от оригинала одно, намеренное: при ошибке API Яндекса оригинал молча возвращал пустой
// отчёт, и у дилера пропадали данные. Здесь ошибка останавливает только этого дилера, его старые
// данные в базе не трогаются, а ошибка видна в итоге запуска.

import { detectMarketingObjective, parseCampaignName, pickModelFieldWaterfall } from '../lib/classify.mjs';

const REPORT_URL = 'https://api.direct.yandex.com/json/v5/reports';
const CAMPAIGNS_URL = 'https://api.direct.yandex.com/json/v5/campaigns';
const REACH_DIVISOR = 3.70587;
const MAX_REPORT_WAIT_MS = 15 * 60 * 1000;
// Лимит частоты API Директа: сколько раз и сколько ждать (растёт с каждой попыткой). Тесты уменьшают паузу.
export const YANDEX_LIMITS = { waitMs: 11000, retries: 8 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Куски по 26 дней, как fetchYdChunkedDates: [start, start+25], затем со следующего дня. */
export function chunkDates(startDate, endDate) {
  const out = [];
  let cur = startDate;
  while (cur <= endDate) {
    let end = addDays(cur, 25);
    if (end > endDate) end = endDate;
    out.push([cur, end]);
    cur = addDays(end, 1);
  }
  return out;
}

/** Цели из ячейки Yandex_Goal_IDs: '123, 456' → [123, 456]. */
export function parseGoals(raw) {
  const s = raw === null || raw === undefined ? '' : raw.toString().trim();
  if (!s) return [];
  // Повтор одной цели не нужен (у Distributor_Mycar_Astana старый портал дописал часть целей дважды).
  return [...new Set(s.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id)))];
}

/** Яндекс принимает в отчёте не больше 10 целей (ошибка 7000 «Array Goals cannot contain more than 10 elements»). */
export const MAX_GOALS_PER_REPORT = 10;
const METRICS = new Set(['Impressions', 'Clicks', 'Cost', 'Conversions']);

/**
 * Отчёты по группам целей → один отчёт: показы, клики и расход — из первой группы, столбцы конверсий всех групп подряд.
 * Строки сопоставляются по измерениям (Date, CampaignName, AdGroupName…). Поле Conversions — последнее в запросе.
 */
export function mergeGoalReports(parts, fields) {
  const nBase = fields.length - 1;
  const nKey = fields.filter((f) => !METRICS.has(f)).length;
  const counts = parts.map((lines) => (lines[0] ? lines[0].split('\t').length - nBase : 0));
  const byKey = new Map();
  parts.forEach((lines, g) => {
    for (const line of lines) {
      const t = line.split('\t');
      const key = t.slice(0, nKey).join('\t');
      let row = byKey.get(key);
      if (!row) {
        row = { base: g === 0 ? t.slice(0, nBase) : t.slice(0, nKey).concat(Array(nBase - nKey).fill('0')), convs: parts.map((_, k) => Array(counts[k]).fill('0')) };
        byKey.set(key, row);
      }
      row.convs[g] = t.slice(nBase);
    }
  });
  return [...byKey.values()].map((r) => r.base.concat(...r.convs).join('\t'));
}

async function fetchCampaignTypes(token, login, fetchImpl) {
  const types = {};
  const res = await fetchImpl(CAMPAIGNS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Client-Login': login, 'Content-Type': 'application/json; charset=utf-8', 'Accept-Language': 'ru' },
    body: JSON.stringify({ method: 'get', params: { SelectionCriteria: {}, FieldNames: ['Id', 'Name', 'Type', 'State', 'Status'] } })
  });
  const json = await res.json().catch(() => ({}));
  if (json.result && json.result.Campaigns) {
    for (const c of json.result.Campaigns) if (c.Name) types[c.Name] = c.Type || '';
  }
  return types; // как в оригинале: без типов кампаний выгрузка продолжается (fallback по имени)
}

async function fetchReport(o) {
  const { goals, fields } = o;
  if (goals.length <= MAX_GOALS_PER_REPORT) return fetchReportOnce(o);
  const parts = [];
  for (let i = 0; i < goals.length; i += MAX_GOALS_PER_REPORT) parts.push(await fetchReportOnce({ ...o, goals: goals.slice(i, i + MAX_GOALS_PER_REPORT) }));
  return mergeGoalReports(parts, fields);
}

async function fetchReportOnce({ token, login, goals, reportType, fields, from, to, fetchImpl, dealerId }) {
  let reqFields = fields.slice();
  if (goals.length === 0) reqFields = reqFields.filter((f) => f !== 'Conversions');
  const params = {
    SelectionCriteria: { DateFrom: from, DateTo: to }, FieldNames: reqFields,
    ReportName: 'Yd_GH_' + reportType + '_' + Math.random().toString().substring(2, 10),
    ReportType: reportType, DateRangeType: 'CUSTOM_DATE', Format: 'TSV', IncludeVAT: 'YES', IncludeDiscount: 'NO'
  };
  if (goals.length > 0) { params.Goals = goals; params.AttributionModels = ['AUTO']; }
  const headers = { Authorization: 'Bearer ' + token, 'Client-Login': login, skipReportHeader: 'true',
    skipColumnHeader: 'true', skipReportSummary: 'true', processingMode: 'auto' };
  const started = Date.now();
  let limited = 0;
  for (;;) {
    const res = await fetchImpl(REPORT_URL, { method: 'POST', headers, body: JSON.stringify({ params }) });
    const text = await res.text();
    if (res.status === 200) return text.split('\n').filter((r) => r.length > 5);
    // Лимит частоты Яндекса (код 56 «не больше 10 запросов за 10 секунд», 152 — баллы): переждать и повторить, а не падать.
    if (res.status === 400 && /"error_code"\s*:\s*"?(56|152)"?/.test(text) && limited < YANDEX_LIMITS.retries) {
      limited++;
      await sleep(YANDEX_LIMITS.waitMs * limited);
      continue;
    }
    if (res.status === 201 || res.status === 202) {
      if (Date.now() - started > MAX_REPORT_WAIT_MS) {
        throw new Error(`Яндекс не подготовил отчёт ${reportType} за ${from} — ${to} за 15 минут`);
      }
      const retryIn = Math.min(Math.max(Number(res.headers.get('retryIn')) || 5, 2), 60);
      await sleep(retryIn * 1000);
      continue;
    }
    throw new Error(`API Яндекса [${dealerId}] HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
}

/**
 * Строки daily_statistics одного дилера за период — до пересчёта курсов и отсева пустых строк.
 * @param {{dealerId: string, token: string, login: string, goals: number[], startDate: string, endDate: string,
 *          dicts: object, nbRates: Record<string, number>, fetchImpl?: typeof fetch}} o
 */
export async function yandexDealerRows(o) {
  const { dealerId, token, login, goals, startDate, endDate, dicts, nbRates } = o;
  const fetchImpl = o.fetchImpl || fetch;
  const rep = (reportType, fields, from, to) =>
    fetchReport({ token, login, goals, reportType, fields, from, to, fetchImpl, dealerId });
  const chunked = async (reportType, fields) => {
    let all = [];
    for (const [from, to] of chunkDates(startDate, endDate)) {
      all = all.concat(await rep(reportType, fields, from, to));
      if (o.onChunk) o.onChunk(); // прогресс выгрузки для админки
    }
    return all;
  };

  const campaignTypes = await fetchCampaignTypes(token, login, fetchImpl).catch(() => ({}));
  const totalsByCamp = {};
  const allocatedByCamp = {};
  const aggregatedData = {};

  for (const line of await chunked('CAMPAIGN_PERFORMANCE_REPORT', ['Date', 'CampaignName', 'Impressions', 'Clicks', 'Cost', 'Conversions'])) {
    const t = line.split('\t');
    const date = t[0];
    const cName = t[1];
    let convs = 0;
    if (goals.length > 0) for (let col = 5; col < t.length; col++) convs += parseFloat(t[col]) || 0;
    totalsByCamp[date + '|||' + cName] = { date, cName, impr: parseInt(t[2]) || 0, reach: Math.round((parseInt(t[2]) || 0) / REACH_DIVISOR),
      clicks: parseInt(t[3]) || 0, cost: (parseFloat(t[4]) || 0) / 1000000, convs };
  }

  for (const line of await chunked('CUSTOM_REPORT', ['Date', 'CampaignName', 'AdGroupName', 'Impressions', 'Clicks', 'Cost', 'Conversions'])) {
    const tA = line.split('\t');
    const date = tA[0];
    const cName = tA[1];
    const asName = tA[2];
    const wf = pickModelFieldWaterfall(cName, asName, null, dealerId, dicts);
    const finalName = wf.field === 'camp' ? cName : (wf.field === 'ag' ? cName + '_' + asName : cName + '_another');
    const fKey = date + '|||' + finalName;
    const campKey = date + '|||' + cName;
    let cvAd = 0;
    if (goals.length > 0) for (let col = 6; col < tA.length; col++) cvAd += parseFloat(tA[col]) || 0;
    const impr = parseInt(tA[3]) || 0;
    const reach = Math.round(impr / REACH_DIVISOR);
    const clicks = parseInt(tA[4]) || 0;
    const cost = (parseFloat(tA[5]) || 0) / 1000000;
    if (!aggregatedData[fKey]) aggregatedData[fKey] = { date, name: finalName, origCName: cName, impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 };
    const a = aggregatedData[fKey];
    a.impr += impr; a.reach += reach; a.clicks += clicks; a.cost += cost; a.convs += cvAd;
    if (!allocatedByCamp[campKey]) allocatedByCamp[campKey] = { impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 };
    const b = allocatedByCamp[campKey];
    b.impr += impr; b.reach += reach; b.clicks += clicks; b.cost += cost; b.convs += cvAd;
  }

  // Сверка с итогом за весь период: если месячные конверсии больше суммы дневных — разница в последний день.
  const monthlyConvs = {};
  for (const line of await rep('CAMPAIGN_PERFORMANCE_REPORT', ['CampaignName', 'Conversions'], startDate, endDate)) {
    const m = line.split('\t');
    if (m.length < 2 || !m[0] || m[0] === 'CampaignName') continue;
    let conv = 0;
    if (goals.length > 0) for (let mc = 1; mc < m.length; mc++) conv += parseFloat(m[mc]) || 0;
    monthlyConvs[m[0]] = (monthlyConvs[m[0]] || 0) + conv;
  }
  const dailySums = {};
  const lastDayKeys = {};
  for (const k of Object.keys(totalsByCamp)) {
    const t = totalsByCamp[k];
    dailySums[t.cName] = (dailySums[t.cName] || 0) + t.convs;
    if (!lastDayKeys[t.cName] || lastDayKeys[t.cName] < k) lastDayKeys[t.cName] = k;
  }
  for (const cn of Object.keys(monthlyConvs)) {
    const etalon = Math.round(monthlyConvs[cn]);
    const daily = Math.round(dailySums[cn] || 0);
    if (etalon > daily && lastDayKeys[cn]) totalsByCamp[lastDayKeys[cn]].convs += etalon - daily;
  }

  // Остаток кампании (итог кампании минус разнесённое по группам) — под оригинальным именем кампании.
  for (const k of Object.keys(totalsByCamp)) {
    const t = totalsByCamp[k];
    const alloc = allocatedByCamp[k] || { impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 };
    const rImpr = Math.max(0, t.impr - alloc.impr);
    const rCost = Math.max(0, t.cost - alloc.cost);
    const rConvs = Math.max(0, t.convs - alloc.convs);
    if (rImpr > 0 || rCost > 0 || rConvs > 0) {
      const remKey = t.date + '|||' + t.cName;
      if (!aggregatedData[remKey]) aggregatedData[remKey] = { date: t.date, name: t.cName, origCName: t.cName, impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 };
      const r = aggregatedData[remKey];
      r.impr += rImpr; r.reach += Math.max(0, t.reach - alloc.reach); r.clicks += Math.max(0, t.clicks - alloc.clicks);
      r.cost += rCost; r.convs += rConvs;
    }
  }

  const rows = [];
  for (const key of Object.keys(aggregatedData)) {
    const agg = aggregatedData[key];
    const rate = nbRates[agg.date] || 450;
    const parsed = parseCampaignName(agg.name, dealerId, dicts);
    let goal = detectMarketingObjective(agg.name, campaignTypes[agg.origCName || agg.name]);
    if (goal === 'Another') goal = parsed.objective;
    rows.push({
      Date: agg.date, Platform: 'Yandex', Dealer_ID: dealerId, Dealer_Type: dealerId.includes('Distributor') ? 'Дистрибьютор' : 'Дилер',
      Campaign_Name: agg.name, Impressions: agg.impr, Reach: agg.reach, Clicks: agg.clicks, Conversions: Math.round(agg.convs),
      Spend_KZT: agg.cost, Spend_USD: agg.cost / rate, Marketing_Objective: goal, Campaign_Type: parsed.type,
      Car_Brand: parsed.brand, Car_Model: parsed.model
    });
  }
  return rows;
}
