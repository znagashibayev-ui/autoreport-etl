// Текущие дневные бюджеты кампаний прямо из рекламных кабинетов (Meta, TikTok, Google Ads, Яндекс.Директ) — только чтение.
// Возвращают [{ campaign, status, daily, total, currency, mode }]:
//   daily — дневной бюджет в валюте кабинета (если бюджет на уровне групп — сумма дневных бюджетов активных групп);
//   total — бюджет на весь срок, если дневного нет; mode — day | adsets | weekly | total | none.

import { GOOGLE_LOGIN_CUSTOMER_ID, googleAccessToken } from '../platforms/googleads.mjs';

const META = 'https://graph.facebook.com/v23.0/';
const TIKTOK = 'https://business-api.tiktok.com/open_api/v1.3/';
const GADS = 'https://googleads.googleapis.com/v24/customers/';
const YANDEX = 'https://api.direct.yandex.com/json/v5/campaigns';
// у Meta суммы в «центах»; у этих валют дробной части нет (Meta: currency offset = 1)
const META_NO_CENTS = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
const round2 = (v) => Math.round(v * 100) / 100;

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
}

/* ---------- Meta ---------- */

async function metaPages(fetchImpl, url) {
  const out = [];
  for (let page = 0; url && page < 20; page++) {
    const { j } = await getJson(fetchImpl, url);
    if (j.error) throw new Error('Meta: ' + (j.error.message || JSON.stringify(j.error)).slice(0, 200));
    out.push(...(j.data || []));
    url = j.paging && j.paging.next ? j.paging.next : '';
  }
  return out;
}

export async function metaBudgets(accountId, token, fetchImpl = fetch) {
  const act = 'act_' + String(accountId).replace(/act_/g, '');
  const q = (o) => new URLSearchParams({ ...o, access_token: token }).toString();
  const { j: acc } = await getJson(fetchImpl, META + act + '?' + q({ fields: 'currency' }));
  if (acc.error) throw new Error('Meta: ' + (acc.error.message || '').slice(0, 200));
  const currency = acc.currency || 'USD';
  const div = META_NO_CENTS.has(currency) ? 1 : 100;
  const live = JSON.stringify(['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']);
  const camps = await metaPages(fetchImpl, META + act + '/campaigns?' + q({ fields: 'id,name,daily_budget,lifetime_budget,effective_status', limit: '500', effective_status: live }));
  const needSets = camps.some((c) => !Number(c.daily_budget) && !Number(c.lifetime_budget));
  const sets = needSets ? await metaPages(fetchImpl, META + act + '/adsets?' + q({ fields: 'campaign_id,daily_budget,lifetime_budget,effective_status', limit: '500', effective_status: live })) : [];
  return camps.map((c) => {
    const base = { campaign: c.name, status: c.effective_status || '', currency };
    if (Number(c.daily_budget)) return { ...base, daily: round2(c.daily_budget / div), total: null, mode: 'day' };
    if (Number(c.lifetime_budget)) return { ...base, daily: null, total: round2(c.lifetime_budget / div), mode: 'total' };
    // бюджет на уровне групп: сумма дневных бюджетов активных групп
    const own = sets.filter((s) => s.campaign_id === c.id && s.effective_status === 'ACTIVE');
    const d = own.reduce((s, x) => s + (Number(x.daily_budget) || 0), 0);
    const t = own.reduce((s, x) => s + (Number(x.lifetime_budget) || 0), 0);
    return { ...base, daily: d ? round2(d / div) : null, total: !d && t ? round2(t / div) : null, mode: d ? 'adsets' : t ? 'total' : 'none' };
  });
}

/* ---------- TikTok ---------- */

async function tiktokList(fetchImpl, token, path, params) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const url = TIKTOK + path + '?' + new URLSearchParams({ ...params, page: String(page), page_size: '1000' });
    const { j } = await getJson(fetchImpl, url, { headers: { 'Access-Token': token } });
    if (j.code !== 0) throw new Error('TikTok: ' + String(j.message || 'код ' + j.code).slice(0, 200));
    const d = j.data || {};
    out.push(...(d.list || []));
    const pi = d.page_info || {};
    if (!pi.total_page || page >= pi.total_page) break;
  }
  return out;
}

export async function tiktokBudgets(advId, token, fetchImpl = fetch) {
  const id = String(advId);
  // валюта кабинета: у приложения может не быть права на advertiser/info — тогда USD, как считает выгрузка TikTok (сумма API → Spend_USD)
  const { j: info } = await getJson(fetchImpl, TIKTOK + 'advertiser/info/?' + new URLSearchParams({ advertiser_ids: JSON.stringify([id]), fields: JSON.stringify(['currency']) }),
    { headers: { 'Access-Token': token } }).catch(() => ({ j: {} }));
  const currency = (info.code === 0 && (((info.data || {}).list || [])[0] || {}).currency) || 'USD';
  const camps = await tiktokList(fetchImpl, token, 'campaign/get/', { advertiser_id: id,
    fields: JSON.stringify(['campaign_id', 'campaign_name', 'budget', 'budget_mode', 'operation_status', 'secondary_status']) });
  const live = camps.filter((c) => !/DELETE/.test(String(c.secondary_status || '')));
  const needGroups = live.some((c) => c.budget_mode === 'BUDGET_MODE_INFINITE');
  const groups = needGroups ? await tiktokList(fetchImpl, token, 'adgroup/get/', { advertiser_id: id,
    fields: JSON.stringify(['campaign_id', 'budget', 'budget_mode', 'operation_status']) }) : [];
  return live.map((c) => {
    const base = { campaign: c.campaign_name, status: c.operation_status === 'ENABLE' ? 'ACTIVE' : 'PAUSED', currency };
    if (/DAY|DYNAMIC_DAILY/.test(c.budget_mode || '') && Number(c.budget)) return { ...base, daily: round2(Number(c.budget)), total: null, mode: 'day' };
    if (c.budget_mode === 'BUDGET_MODE_TOTAL' && Number(c.budget)) return { ...base, daily: null, total: round2(Number(c.budget)), mode: 'total' };
    const own = groups.filter((g) => String(g.campaign_id) === String(c.campaign_id) && g.operation_status === 'ENABLE');
    const d = own.filter((g) => /DAY|DYNAMIC_DAILY/.test(g.budget_mode || '')).reduce((s, g) => s + (Number(g.budget) || 0), 0);
    const t = own.filter((g) => g.budget_mode === 'BUDGET_MODE_TOTAL').reduce((s, g) => s + (Number(g.budget) || 0), 0);
    return { ...base, daily: d ? round2(d) : null, total: !d && t ? round2(t) : null, mode: d ? 'adsets' : t ? 'total' : 'none' };
  });
}

/* ---------- Google Ads ---------- */

export async function googleBudgets(customerId, refreshToken, keys, fetchImpl = fetch) {
  const at = await googleAccessToken(refreshToken, keys, fetchImpl, 1000);
  if (!at) throw new Error('Google: токен недействителен (refresh token отозван)');
  const cid = String(customerId).replace(/-/g, '');
  const headers = { Authorization: 'Bearer ' + at, 'developer-token': keys.developerToken, 'login-customer-id': GOOGLE_LOGIN_CUSTOMER_ID, 'Content-Type': 'application/json' };
  const query = 'SELECT campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.period, campaign_budget.total_amount_micros, ' +
    "customer.currency_code FROM campaign WHERE campaign.status != 'REMOVED'";
  const out = [];
  let pageToken = null;
  do {
    const { j } = await getJson(fetchImpl, GADS + cid + '/googleAds:search', { method: 'POST', headers, body: JSON.stringify(pageToken ? { query, pageToken } : { query }) });
    if (j.error) throw new Error('Google: ' + String(j.error.message || JSON.stringify(j.error)).slice(0, 200));
    for (const r of j.results || []) {
      const b = r.campaignBudget || {};
      const daily = Number(b.amountMicros) ? round2(Number(b.amountMicros) / 1e6) : null;
      const total = !daily && Number(b.totalAmountMicros) ? round2(Number(b.totalAmountMicros) / 1e6) : null;
      out.push({ campaign: r.campaign.name, status: r.campaign.status === 'ENABLED' ? 'ACTIVE' : r.campaign.status || '', currency: (r.customer || {}).currencyCode || 'USD',
        daily, total, mode: daily ? 'day' : total ? 'total' : 'none' });
    }
    pageToken = j.nextPageToken || null;
  } while (pageToken);
  return out;
}

/* ---------- Яндекс.Директ ---------- */

/** Недельный лимит стратегии (WeeklySpendLimit в любой ветке BiddingStrategy), в микроединицах. */
export function weeklyLimit(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let best = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'WeeklySpendLimit' && Number(v)) best = Math.max(best, Number(v));
    else if (v && typeof v === 'object') best = Math.max(best, weeklyLimit(v));
  }
  return best;
}

export async function yandexBudgets(login, token, fetchImpl = fetch) {
  const strat = ['BiddingStrategy'];
  const { status, j } = await getJson(fetchImpl, YANDEX, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Client-Login': login, 'Content-Type': 'application/json; charset=utf-8', 'Accept-Language': 'ru' },
    body: JSON.stringify({ method: 'get', params: { SelectionCriteria: { States: ['ON', 'OFF', 'SUSPENDED', 'ENDED'] },
      FieldNames: ['Name', 'State', 'Currency', 'DailyBudget'],
      TextCampaignFieldNames: strat, UnifiedCampaignFieldNames: strat, DynamicTextCampaignFieldNames: strat, SmartCampaignFieldNames: strat } })
  });
  if (j.error) throw new Error('Яндекс: ' + ((j.error.error_string || 'HTTP ' + status) + (j.error.error_detail ? ' — ' + j.error.error_detail : '')).slice(0, 200));
  return ((j.result && j.result.Campaigns) || []).filter((c) => c.State !== 'ENDED' && c.State !== 'ARCHIVED').map((c) => {
    const base = { campaign: c.Name, status: c.State === 'ON' ? 'ACTIVE' : 'PAUSED', currency: c.Currency || 'KZT' };
    const day = c.DailyBudget && Number(c.DailyBudget.Amount) ? round2(Number(c.DailyBudget.Amount) / 1e6) : 0;
    if (day) return { ...base, daily: day, total: null, mode: 'day' };
    const strategy = c.TextCampaign || c.UnifiedCampaign || c.DynamicTextCampaign || c.SmartCampaign || {};
    const wk = weeklyLimit(strategy.BiddingStrategy);
    return { ...base, daily: wk ? round2(wk / 1e6 / 7) : null, total: null, mode: wk ? 'weekly' : 'none' };
  });
}
