/**
 * 05_Yandex.gs — выгрузка Яндекс.Директ.
 * Registry: yandex_client_login — логин клиента (Client-Login), например porg-xshmlj3c
 *           yandex_goal_ids     — "513995558, 12345" (пусто = все конверсии суммарно)
 *           yandex_token_key    — имя свойства с токеном, если не общий YANDEX_TOKEN
 * Один агентский токен работает на всех клиентов агентства; если у дилера свой токен —
 * положи его в свойства (например YANDEX_TOKEN_MYCAR) и укажи это имя в yandex_token_key.
 *
 * ИЗМЕНЕНО:
 *   Y6. HTTP 204 (No Content) — Директ не отдал данные. Режим задаёт Config YANDEX_204_MODE:
 *         KEEP  (по умолчанию) — строки Yandex в МП НЕ удаляются: остаются с прошлой
 *               выгрузки, остальные площадки обновляются. Не считается ошибкой:
 *               строка в Registry не краснеет, в Telegram ничего не уходит.
 *               Как только Директ снова отдаёт данные (HTTP 200) — строки Yandex
 *               обновляются сами, ничего переключать не нужно.
 *         ERROR — то же сохранение строк, но с ошибкой: журнал, красная строка, Telegram.
 *         EMPTY — 204 = пустой отчёт, строки Yandex из МП удаляются (старое поведение).
 *   Y7. Текст ошибки Директа разбирается из XML/JSON: "HTTP 400, код 4000: …" —
 *       по коду «Журнал ошибок» подбирает причину и способ исправления.
 *   Y8. yandexDiag('dealer_id', '2026-10-01', '2026-10-12') — печатает в лог сырые
 *       ответы Директа (с целями и без целей): коды, заголовки, первые строки отчёта.
 *   Y9. Правила Mapping с аккаунтом (колонка C = логин клиента) применяются только
 *       к кампаниям этого логина.
 */

var YANDEX_REPORTS_URL = 'https://api.direct.yandex.com/json/v5/reports';

function fetchYandex(dealer, df, dt, disp) {
  var login = String(dealer.yandex_client_login || '').trim();
  if (!login) return null;
  var token = tokenFor(dealer, 'yandex');
  var goals = splitIds(dealer.yandex_goal_ids).filter(function (g) { return /^\d+$/.test(g); });

  var r = yandexReport_(token, login, df, dt, goals);
  if (r.code === 204) {
    var mode = yandex204Mode_();
    if (mode === 'EMPTY') {
      Logger.log('Yandex ' + login + ': HTTP 204 — считаю пустым отчётом (YANDEX_204_MODE = EMPTY)');
      return [];
    }
    var err = new Error('Yandex ' + login + ' HTTP 204: Директ не отдал данные за ' + df + '..' + dt);
    if (mode === 'KEEP') err.keepOldData = true;   // 06_Pipeline: оставить строки, без ошибки
    throw err;
  }
  return parseYandexTsv_(r.text, disp, login);
}

/** KEEP | ERROR | EMPTY (что угодно другое → KEEP). */
function yandex204Mode_() {
  var m = String(configValue('YANDEX_204_MODE') || 'KEEP').trim().toUpperCase();
  return (m === 'ERROR' || m === 'EMPTY') ? m : 'KEEP';
}

/** Параметры запроса отчёта. */
function yandexRequestOpt_(token, login, df, dt, goals) {
  var params = {
    SelectionCriteria: { DateFrom: df, DateTo: dt },
    FieldNames: ['CampaignName', 'Impressions', 'Clicks', 'Conversions', 'Cost'],
    ReportName: 'Hub_' + login + '_' + df.replace(/-/g, '') + '_' + dt.replace(/-/g, '') + '_' + Math.floor(Math.random() * 1e6),
    ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
    DateRangeType: 'CUSTOM_DATE',
    Format: 'TSV',
    IncludeVAT: 'YES',
    IncludeDiscount: 'NO'
  };
  if (goals && goals.length) {
    params.Goals = goals;
    params.AttributionModels = [String(configValue('YANDEX_ATTRIBUTION') || 'AUTO')];
  }
  return {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Client-Login': login,
      'Accept-Language': 'ru',
      'processingMode': 'auto',
      'returnMoneyInMicros': 'false',
      'skipReportHeader': 'true',
      'skipColumnHeader': 'false',
      'skipReportSummary': 'true'
    },
    payload: JSON.stringify({ params: params }),
    muteHttpExceptions: true
  };
}

/** → {code: 200, text} | {code: 204, text: ''}; всё остальное — исключение. */
function yandexReport_(token, login, df, dt, goals) {
  var opt = yandexRequestOpt_(token, login, df, dt, goals);
  var lastCode = 0, lastBody = '';
  for (var attempt = 1; attempt <= 8; attempt++) {
    var res = UrlFetchApp.fetch(YANDEX_REPORTS_URL, opt);
    var code = res.getResponseCode();
    lastCode = code;
    if (code === 200) return { code: 200, text: res.getContentText() };
    if (code === 204) return { code: 204, text: '' };
    if (code === 201 || code === 202) {
      var h = res.getAllHeaders() || {};
      var wait = parseInt(h.retryIn || h.RetryIn || h.retryin, 10);
      if (!wait || wait < 1) wait = 5;
      if (wait > 30) wait = 30;
      Utilities.sleep(wait * 1000);
      continue;
    }
    if (code === 429 || code >= 500) {
      lastBody = yandexErrText_(res.getContentText());
      Utilities.sleep(5000);
      continue;
    }
    throw new Error('Yandex ' + login + ' HTTP ' + code + ', ' + yandexErrText_(res.getContentText()));
  }
  if (lastCode === 429 || lastCode >= 500) {
    throw new Error('Yandex ' + login + ' HTTP ' + lastCode + ' после 8 попыток, ' + lastBody);
  }
  throw new Error('Yandex ' + login + ': отчёт не сформировался за 8 попыток');
}

/** XML/JSON ошибки Директа → "код 53: Ошибка авторизации — подробности". */
function yandexErrText_(body) {
  var s = String(body || '');
  try {
    var j = JSON.parse(s);
    if (j && j.error) {
      return 'код ' + (j.error.error_code || '?') + ': ' + (j.error.error_string || '') +
             (j.error.error_detail ? ' — ' + j.error.error_detail : '');
    }
  } catch (e) { /* не JSON — значит XML */ }
  var c = /errorCode>\s*(\d+)\s*</.exec(s);
  var m = /errorMessage>([^<]*)</.exec(s);
  var d = /errorDetail>([^<]*)</.exec(s);
  if (c || m) {
    return 'код ' + (c ? c[1] : '?') + ': ' + (m ? m[1].trim() : '') + (d && d[1].trim() ? ' — ' + d[1].trim() : '');
  }
  return s.replace(/\s+/g, ' ').substring(0, 300) || '(пустой ответ)';
}

function parseYandexTsv_(text, disp, login) {
  var lines = String(text || '').split('\n').filter(function (l) { return l.replace(/[\s\r]/g, '') !== ''; });
  if (!lines.length) return [];
  var header = lines.shift().split('\t').map(function (h) { return h.replace(/\r/g, '').trim(); });
  var idx = {}; header.forEach(function (h, i) { idx[h] = i; });
  var convCols = []; header.forEach(function (h, i) { if (h.indexOf('Conversions') === 0) convCols.push(i); });
  if (idx.CampaignName === undefined || idx.Impressions === undefined) throw new Error('Yandex: нет колонок CampaignName/Impressions');

  var agg = {};
  lines.forEach(function (line) {
    var t = line.split('\t');
    var camp = mapCampaignForAccount((t[idx.CampaignName] || '').replace(/\r/g, ''), login);   // Y9
    if (!camp) return;
    var impr = Math.round(num_(t[idx.Impressions])), clicks = Math.round(num_(t[idx.Clicks]));
    var cost = num_(t[idx.Cost]), conv = 0;
    convCols.forEach(function (ci) { conv += num_(t[ci]); });
    if (!rowHasData(impr, clicks, conv, cost)) return;
    if (!agg[camp]) agg[camp] = { impr: 0, clicks: 0, conv: 0, cost: 0 };
    agg[camp].impr += impr; agg[camp].clicks += clicks; agg[camp].conv += conv; agg[camp].cost += cost;
  });

  var divisor = configNum('YANDEX_REACH_DIVISOR') || 3.70587;
  return Object.keys(agg).map(function (camp) {
    var s = agg[camp];
    return [disp, camp, s.impr, Math.round(s.impr / divisor), s.clicks, Math.ceil(s.conv), s.cost];
  });
}

function yandexSelfCheck_(token, login) {
  var res = UrlFetchApp.fetch('https://api.direct.yandex.com/json/v5/campaigns', {
    method: 'post', contentType: 'application/json; charset=utf-8',
    headers: { 'Authorization': 'Bearer ' + token, 'Client-Login': login, 'Accept-Language': 'ru' },
    payload: JSON.stringify({ method: 'get', params: { SelectionCriteria: {}, FieldNames: ['Id'], Page: { Limit: 1 } } }),
    muteHttpExceptions: true
  });
  var j = JSON.parse(res.getContentText());
  if (j.error) throw new Error(JSON.stringify(j.error).substring(0, 200));
  return 'OK (' + login + ')';
}

// ---------------------------------------------------------------------------
// ДИАГНОСТИКА — что именно отвечает Директ
// ---------------------------------------------------------------------------
/**
 * yandexDiag('Distributor_BYD', '2026-10-01', '2026-10-12')
 * Делает два запроса — с целями из Registry и без целей — и печатает в лог
 * все коды ответа, заголовки и первые строки отчёта. Ничего не пишет в МП.
 * Плюс проверяет, сколько у логина кампаний и в каком они статусе.
 */
function yandexDiag(dealerId, df, dt) {
  var dealer = findDealer(dealerId);
  if (!dealer) { Logger.log('Дилер не найден: ' + dealerId); return; }
  var login = String(dealer.yandex_client_login || '').trim();
  if (!login) { Logger.log('У дилера пустой yandex_client_login'); return; }
  var token = tokenFor(dealer, 'yandex');
  var goals = splitIds(dealer.yandex_goal_ids).filter(function (g) { return /^\d+$/.test(g); });

  Logger.log('=== Yandex диагностика: ' + dealerId + ' | ' + login + ' | ' + df + '..' + dt + ' ===');

  [['с целями ' + (goals.join(',') || '(целей нет)'), goals], ['без целей', []]].forEach(function (v) {
    Logger.log('--- Запрос ' + v[0] + ' ---');
    var opt = yandexRequestOpt_(token, login, df, dt, v[1]);
    for (var attempt = 1; attempt <= 8; attempt++) {
      var res = UrlFetchApp.fetch(YANDEX_REPORTS_URL, opt);
      var code = res.getResponseCode();
      var h = res.getAllHeaders() || {};
      Logger.log('Попытка ' + attempt + ': HTTP ' + code +
                 ' | retryIn=' + (h.retryIn || h.RetryIn || '—') +
                 ' | units=' + (h.units || h.Units || '—') +
                 ' | requestId=' + (h.requestId || h.RequestId || '—'));
      if (code === 201 || code === 202) { Utilities.sleep(5000); continue; }
      var body = res.getContentText();
      if (code === 200) {
        var lines = body.split('\n');
        Logger.log('Строк в отчёте: ' + Math.max(0, lines.length - 2));
        lines.slice(0, 6).forEach(function (l) { Logger.log('   ' + l); });
      } else if (code === 204) {
        Logger.log('204 — отчёт пустой, статистики за период нет');
      } else {
        Logger.log('Ответ: ' + yandexErrText_(body));
      }
      break;
    }
  });

  try {
    var res2 = UrlFetchApp.fetch('https://api.direct.yandex.com/json/v5/campaigns', {
      method: 'post', contentType: 'application/json; charset=utf-8',
      headers: { 'Authorization': 'Bearer ' + token, 'Client-Login': login, 'Accept-Language': 'ru' },
      payload: JSON.stringify({ method: 'get', params: { SelectionCriteria: {},
        FieldNames: ['Id', 'Name', 'State', 'Status'], Page: { Limit: 50 } } }),
      muteHttpExceptions: true
    });
    var j = JSON.parse(res2.getContentText());
    if (j.error) { Logger.log('Кампании: ' + JSON.stringify(j.error)); return; }
    var list = (j.result && j.result.Campaigns) || [];
    Logger.log('--- Кампаний у логина: ' + list.length + ' ---');
    list.forEach(function (c) { Logger.log('   ' + c.Id + ' | ' + c.State + ' | ' + c.Status + ' | ' + c.Name); });
  } catch (e) { Logger.log('Кампании: ' + e.message); }
}