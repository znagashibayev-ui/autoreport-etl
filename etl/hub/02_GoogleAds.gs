/**
 * 02_GoogleAds.gs — выгрузка Google Ads через Google Ads API (MCC).
 *
 * Свойства скрипта: GADS_DEVELOPER_TOKEN, GADS_CLIENT_ID, GADS_CLIENT_SECRET,
 *                   GADS_REFRESH_TOKEN, GADS_MCC_ID
 * Registry: google_customer_id — один или несколько через запятую (123-456-7890, 555-666-7777),
 *           google_conv_include — какие конверсии считать лидами (подстроки через запятую,
 *                                 например: form_send, uniq_call). Пусто = все конверсии.
 *           google_conv_exclude — стоп-слова (например: start, click_phone).
 *
 * ФИКСИРОВАННЫЕ КОНВЕРСИИ (вкладка Overrides в Hub):
 *   Если за какие-то дни конверсии в Google Ads неверные и нужно подставить своё число,
 *   строка в Overrides:  dealer_id | platform | campaign | date_from | date_to | conversions | comment
 *   Для периода выгрузки, который пересекается с date_from..date_to:
 *     конверсии = API за весь период − API за дни фикса + conversions из Overrides
 *   Дни вне фикса продолжают считаться из API как обычно.
 *   Пример: 1–29 сен = 54 → выгрузка 1–29 сен даст 54, выгрузка 1–30 сен даст 54 + API за 30-е.
 *   campaign — имя кампании КАК В GOOGLE ADS (до переименования через Mapping).
 *   Вкладка создаётся сама при первом запуске, с уже заполненной первой строкой.
 *
 * ИЗМЕНЕНО:
 *   G1. Правила Mapping с аккаунтом (колонка C = customer ID) применяются к кампаниям
 *       этого аккаунта ДО сложения аккаунтов по имени (googleAccountStats_).
 *       Overrides находит кампанию и по имени из Google Ads, и по новому имени из Mapping.
 */

var OVERRIDES_SHEET   = 'Overrides';
var OVERRIDES_HEADERS = ['dealer_id', 'platform', 'campaign', 'date_from', 'date_to', 'conversions', 'comment'];
var OVERRIDES_SEED    = [
  ['Dealer_Hyundai_Premium_Al-Farabi', 'Google', 'google_perf_search_hyundai_af',
   '2026-09-01', '2026-09-29', 54, '1–29 сен фикс 54 конв., с 30 сен — из Google Ads']
];
var OVERRIDES_CACHE_ = null;

function gadsAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('GADS_ACCESS_TOKEN');
  if (cached) return cached;

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      client_id:     prop_('GADS_CLIENT_ID'),
      client_secret: prop_('GADS_CLIENT_SECRET'),
      refresh_token: prop_('GADS_REFRESH_TOKEN'),
      grant_type:    'refresh_token'
    },
    muteHttpExceptions: true
  });
  var j = JSON.parse(res.getContentText());
  if (!j.access_token) throw new Error('Google OAuth: ' + res.getContentText().substring(0, 300));
  cache.put('GADS_ACCESS_TOKEN', j.access_token, 3000);   // 50 минут
  return j.access_token;
}

function gadsHeaders_() {
  var mcc = String(prop_('GADS_MCC_ID') || '').replace(/-/g, '');
  var dev = prop_('GADS_DEVELOPER_TOKEN');
  if (!mcc || !dev) throw new Error('Заполни GADS_MCC_ID и GADS_DEVELOPER_TOKEN в свойствах скрипта');
  return {
    'Authorization':     'Bearer ' + gadsAccessToken_(),
    'developer-token':   dev,
    'login-customer-id': mcc
  };
}

/** Выполняет GAQL через searchStream, возвращает массив results. */
function gadsQuery_(customerId, gaql) {
  var cid = String(customerId).replace(/-/g, '');
  var url = 'https://googleads.googleapis.com/' + configValue('GADS_API_VERSION') +
            '/customers/' + cid + '/googleAds:searchStream';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: gadsHeaders_(),
    payload: JSON.stringify({ query: gaql }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error('Google Ads API ' + code + ': ' + text.substring(0, 400));
  var batches = JSON.parse(text);
  if (!Array.isArray(batches)) batches = [batches];
  var results = [];
  batches.forEach(function (b) {
    if (b.error) throw new Error('Google Ads API: ' + JSON.stringify(b.error).substring(0, 400));
    if (b.results) results = results.concat(b.results);
  });
  return results;
}

function fetchGoogle(dealer, df, dt, disp) {
  var ids = splitIds(dealer.google_customer_id).map(function (x) { return x.replace(/-/g, ''); })
                                                .filter(function (x) { return /^\d{10}$/.test(x); });
  if (!ids.length) return null;                            // площадка не настроена

  var inc = splitIds(dealer.google_conv_include).map(function (s) { return s.toLowerCase(); });
  var exc = splitIds(dealer.google_conv_exclude).map(function (s) { return s.toLowerCase(); });

  // Несколько аккаунтов → складываем по имени кампании
  var agg = {};
  ids.forEach(function (cid) { googleAccountStats_(cid, df, dt, inc, exc, agg); });

  // Фиксированные конверсии из вкладки Overrides
  applyGoogleOverrides_(dealer, ids, df, dt, inc, exc, agg);

  var divisor  = configNum('GOOGLE_REACH_DIVISOR') || 2.5;
  var mult     = configNum('GOOGLE_COST_MULTIPLIER') || 1;
  var eqWords  = splitIds(configValue('GOOGLE_REACH_EQUALS_IMPR_KEYWORDS')).map(function (s) { return s.toLowerCase(); });
  var result = [];
  Object.keys(agg).forEach(function (name) {
    var s = agg[name];
    if (!rowHasData(s.impr, s.clicks, s.conv, s.cost)) return;
    var low = name.toLowerCase();
    var reachEqImpr = eqWords.some(function (w) { return low.indexOf(w) > -1; });
    var reach = reachEqImpr ? s.impr : Math.round(s.impr / divisor);
    // конверсии — как в кабинете, без округления (до 2 знаков): 49,05 → 49,05
    result.push([disp, name, s.impr, reach, s.clicks, Math.round(s.conv * 100) / 100, Math.round(s.cost * mult * 100) / 100]);
  });
  return result;
}

/** Статистика одного аккаунта → в общий agg (по имени кампании). */
function googleAccountStats_(cid, df, dt, inc, exc, agg) {
  // 1) показы / клики / расход по кампаниям
  var q1 = "SELECT campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros " +
           "FROM campaign WHERE segments.date BETWEEN '" + df + "' AND '" + dt + "' " +
           "AND campaign.status != 'REMOVED'";
  var rows1;
  try { rows1 = gadsQuery_(cid, q1); }
  catch (e) { throw new Error('аккаунт ' + cid + ': ' + e.message); }
  rows1.forEach(function (r) {
    var name = mapCampaignForAccount(r.campaign && r.campaign.name, cid);   // G1
    if (!name) return;
    var m = r.metrics || {};
    if (!agg[name]) agg[name] = { impr: 0, clicks: 0, conv: 0, cost: 0 };
    agg[name].impr   += parseInt(m.impressions) || 0;
    agg[name].clicks += parseInt(m.clicks) || 0;
    agg[name].cost   += (parseFloat(m.costMicros) || 0) / 1e6;
  });

  // 2) конверсии по действиям — чтобы отфильтровать «лидовые»
  var q2 = "SELECT campaign.name, segments.conversion_action_name, metrics.conversions " +
           "FROM campaign WHERE segments.date BETWEEN '" + df + "' AND '" + dt + "' " +
           "AND metrics.conversions > 0";
  var rows2;
  try { rows2 = gadsQuery_(cid, q2); }
  catch (e) { throw new Error('аккаунт ' + cid + ' (конверсии): ' + e.message); }
  rows2.forEach(function (r) {
    var name = mapCampaignForAccount(r.campaign && r.campaign.name, cid);   // G1
    if (!name || !agg[name]) return;
    var action = String(r.segments && r.segments.conversionActionName || '').toLowerCase();
    var ok = inc.length === 0 || inc.some(function (s) { return action.indexOf(s) > -1; });
    if (ok && exc.some(function (s) { return action.indexOf(s) > -1; })) ok = false;
    if (ok) agg[name].conv += parseFloat(r.metrics && r.metrics.conversions) || 0;
  });
}

// ---------------------------------------------------------------------------
// ФИКСИРОВАННЫЕ КОНВЕРСИИ (вкладка Overrides)
// ---------------------------------------------------------------------------

/** Подменяет конверсии в agg за дни фикса. */
function applyGoogleOverrides_(dealer, ids, df, dt, inc, exc, agg) {
  var id = String(dealer.dealer_id || '').trim().toLowerCase();
  var list = readOverrides_().filter(function (o) {
    return o.dealer === id && (o.platform === '' || o.platform === 'google');
  });
  if (!list.length) return;

  var overlapCache = {};   // "from|to" → agg за дни фикса (один запрос на диапазон)

  list.forEach(function (o) {
    var from = o.from > df ? o.from : df;
    var to   = o.to   < dt ? o.to   : dt;
    if (from > to) return;                               // период не пересекается с фиксом

    var ck = from + '|' + to;
    if (!overlapCache[ck]) {
      overlapCache[ck] = {};
      ids.forEach(function (cid) { googleAccountStats_(cid, from, to, inc, exc, overlapCache[ck]); });
    }
    var apiOverlap = 0;
    var ovKey = findOverrideKey_(overlapCache[ck], o.campaign, ids);
    if (ovKey) apiOverlap = overlapCache[ck][ovKey].conv || 0;

    var key = findOverrideKey_(agg, o.campaign, ids);
    if (!key) {                                          // кампании нет в периоде — создаём строку
      key = o.campaign;
      agg[key] = { impr: 0, clicks: 0, conv: 0, cost: 0 };
    }
    var before = agg[key].conv || 0;
    var after  = Math.max(0, before - apiOverlap + o.conv);
    agg[key].conv = after;

    var note = 'фикс ' + o.from + '..' + o.to + ' = ' + o.conv +
               ' | API за период ' + round2_(before) + ', из них за дни фикса ' + round2_(apiOverlap) +
               ' → итого ' + round2_(after);
    Logger.log('[' + dealer.dealer_id + '] ' + key + ': ' + note);
    logRow(dealer.dealer_id, df + '..' + dt, 'Google FIX', 1, '', key + ': ' + note);
  });
}

/** Ключ кампании в agg без учёта регистра и лишних пробелов. */
function findCampaignKey_(agg, name) {
  var want = normName(name);
  var keys = Object.keys(agg);
  for (var i = 0; i < keys.length; i++) if (normName(keys[i]) === want) return keys[i];
  return null;
}

/** G1: кампания из Overrides — по имени из Google Ads или по новому имени из Mapping аккаунта. */
function findOverrideKey_(agg, name, ids) {
  var key = findCampaignKey_(agg, name);
  for (var i = 0; !key && i < ids.length; i++) key = findCampaignKey_(agg, mapCampaignForAccount(name, ids[i]));
  return key;
}

function round2_(n) { return Math.round((n || 0) * 100) / 100; }

/** Строки вкладки Overrides. Вкладка создаётся с примером, если её нет. */
function readOverrides_() {
  if (OVERRIDES_CACHE_) return OVERRIDES_CACHE_;
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(OVERRIDES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(OVERRIDES_SHEET);
    sh.getRange(1, 1, 1, OVERRIDES_HEADERS.length).setValues([OVERRIDES_HEADERS]).setFontWeight('bold');
    sh.getRange(2, 4, 200, 2).setNumberFormat('@');     // даты храним текстом ГГГГ-ММ-ДД
    sh.getRange(2, 1, OVERRIDES_SEED.length, OVERRIDES_HEADERS.length).setValues(OVERRIDES_SEED);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 260); sh.setColumnWidth(3, 280); sh.setColumnWidth(7, 380);
  }

  var tz = Session.getScriptTimeZone();
  var data = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var o = {
      dealer:   String(r[0] || '').trim().toLowerCase(),
      platform: String(r[1] || '').trim().toLowerCase(),
      campaign: String(r[2] || '').trim(),
      from:     overrideDate_(r[3], tz),
      to:       overrideDate_(r[4], tz),
      conv:     num_(r[5])
    };
    if (!o.dealer || !o.campaign || !o.from || !o.to || o.from > o.to) continue;
    out.push(o);
  }
  OVERRIDES_CACHE_ = out;
  return out;
}

/** Date | "2026-09-01" | "01.09.2026" → "2026-09-01" */
function overrideDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = String(v || '').trim();
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return makeDateStr(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(s);
  if (m) return makeDateStr(+m[3], +m[2], +m[1]);
  return '';
}

/** Проверка: получить токен и список доступных клиентов MCC. */
function gadsSelfCheck_() {
  var url = 'https://googleads.googleapis.com/' + configValue('GADS_API_VERSION') + '/customers:listAccessibleCustomers';
  var res = UrlFetchApp.fetch(url, { headers: gadsHeaders_(), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(res.getContentText().substring(0, 300));
  var j = JSON.parse(res.getContentText());
  return 'OK, доступных аккаунтов: ' + ((j.resourceNames || []).length);
}