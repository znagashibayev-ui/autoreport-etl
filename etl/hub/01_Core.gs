/**
 * 01_Core.gs — AUTOREPORT HUB. Общие настройки и утилиты.
 *
 * Hub — одна таблица + один скрипт на ВСЕХ дилеров.
 *   Registry       — список дилеров (по строке на дилера): какие кабинеты, куда писать.
 *   Mapping        — корректировки названий кампаний (старое → новое [→ аккаунт]); без аккаунта — для всех.
 *   Config         — параметры (часы триггеров, делители охвата, версии API, Telegram).
 *   Log            — что и когда выгрузилось, ошибки.
 *   Журнал ошибок  — ошибки с причиной и способом исправления (11_Errors.gs).
 *
 * Токены лежат в Свойствах скрипта (Настройки проекта → Свойства скрипта):
 *   META_TOKEN, TIKTOK_TOKEN, YANDEX_TOKEN            — общие (по умолчанию)
 *   GADS_DEVELOPER_TOKEN, GADS_CLIENT_ID, GADS_CLIENT_SECRET,
 *   GADS_REFRESH_TOKEN, GADS_MCC_ID                   — Google Ads (MCC)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID              — уведомления об ошибках
 *                                                       (chat_id можно несколько через запятую)
 *   Любой доп. токен: например TIKTOK_TOKEN_MYCAR — имя этого ключа
 *   пишется в Registry в колонку tiktok_token_key (то же для meta_/yandex_).
 *
 * ИЗМЕНЕНО:
 *   • CONFIG_DEFAULTS: YANDEX_204_MODE, ERROR_ROW_COLOR, TG_ENABLED, TG_REPEAT_HOURS,
 *     TG_NOTIFY_RECOVERY, ERROR_JOURNAL_LIMIT.
 *   • setRegistryStatus(dealer, status, isError) — красит строку дилера в Registry
 *     бледно-красным при ошибке и снимает подсветку, когда всё OK.
 *   • Mapping: необязательная колонка C «Аккаунт» (act_id Meta / customer ID Google /
 *     advertiser_id TikTok / логин Яндекса, можно несколько через запятую).
 *     Правило с аккаунтом применяется ТОЛЬКО к кампаниям этого кабинета и ДО того, как
 *     кабинеты дилера складываются по имени — так одинаковые имена из разных кабинетов
 *     можно развести. Пустая колонка C — общее правило, как раньше (после склейки).
 *     Сначала срабатывает правило аккаунта, затем общее правило — уже к новому имени.
 */

var HUB = {
  REGISTRY_SHEET: 'Registry',
  MAPPING_SHEET:  'Mapping',
  CONFIG_SHEET:   'Config',
  LOG_SHEET:      'Log',
  DEFAULT_TARGET_SHEET: 'Ads Data',
  MAX_RUN_MS: 270000,              // 4,5 минуты работы, потом продолжение новым запуском
  QUEUE_KEY: 'HUB_QUEUE',
  QUEUE_MODE_KEY: 'HUB_QUEUE_MODE',
  HEADER_ROW: ['Дата', 'Кампания', 'Показы', 'Охват', 'Клики', 'Конверсии', 'Расход'],
  MONTHS: ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
};

// Колонки Registry (порядок важен только для создания шаблона)
var REGISTRY_HEADERS = [
  'dealer_id', 'brand', 'active',
  'mp_spreadsheet_id', 'mp_sheet_name',
  'google_customer_id', 'google_conv_include', 'google_conv_exclude',
  'meta_act_ids', 'meta_token_key',
  'tiktok_adv_ids', 'tiktok_token_key',
  'yandex_client_login', 'yandex_goal_ids', 'yandex_token_key',
  'last_run', 'last_status'
];

var CONFIG_DEFAULTS = {
  DAILY_HOUR: 6,                  // ежедневный запуск (час, пояс проекта)
  MONTHLY_DAY: 3,                 // число месяца для перевыгрузки закрытого месяца
  MONTHLY_HOUR: 8,
  PREV_MONTH_UNTIL_DAY: 5,        // до какого числа ежедневно ещё обновлять прошлый месяц
  MIN_IMPRESSIONS: 0,
  ADD_PLATFORM_PREFIX: 'FALSE',   // TRUE → "Meta | имя кампании"
  YANDEX_REACH_DIVISOR: 3.70587,  // у Директа нет охвата: показы / делитель
  GOOGLE_REACH_DIVISOR: 2.5,      // Google Ads API не отдаёт охват по кампаниям: показы / делитель (как в AGL)
  GOOGLE_REACH_EQUALS_IMPR_KEYWORDS: 'pmax,search',  // если имя содержит одно из слов — охват = показы
  GOOGLE_COST_MULTIPLIER: 1,      // например 1.16, если расход нужен с НДС
  GADS_API_VERSION: 'v25',
  META_API_VERSION: 'v19.0',
  YANDEX_ATTRIBUTION: 'AUTO',

  // --- ошибки и уведомления ---
  YANDEX_204_MODE: 'KEEP',        // HTTP 204 от Директа: KEEP — оставить в МП прошлые строки Yandex (по умолчанию),
                                  //   ERROR — то же + ошибка (красная строка, Telegram), EMPTY — считать пустым отчётом
  ERROR_ROW_COLOR: '#f4cccc',     // бледно-красный для строки дилера с ошибкой в Registry
  TG_ENABLED: 'TRUE',             // FALSE — не слать в Telegram (журнал и подсветка остаются)
  TG_REPEAT_HOURS: 12,            // одинаковую ошибку дилера не повторять в Telegram чаще; 0 — слать всегда
  TG_NOTIFY_RECOVERY: 'TRUE',     // сообщить, когда у дилера с ошибкой выгрузка снова прошла чисто
  ERROR_JOURNAL_LIMIT: 3000       // строк в «Журнал ошибок», старые удаляются
};

// ---------------------------------------------------------------------------
// СВОЙСТВА И CONFIG
// ---------------------------------------------------------------------------
function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

var CONFIG_CACHE_ = null;
function configValue(key) {
  if (!CONFIG_CACHE_) {
    CONFIG_CACHE_ = {};
    var sh = SpreadsheetApp.getActive().getSheetByName(HUB.CONFIG_SHEET);
    if (sh) {
      sh.getDataRange().getValues().forEach(function (r) {
        if (r[0] !== '' && r[0] !== null) CONFIG_CACHE_[String(r[0]).trim()] = r[1];
      });
    }
  }
  var v = CONFIG_CACHE_[key];
  if (v === undefined || v === null || v === '') v = CONFIG_DEFAULTS[key];
  return v;
}
function configNum(key) {
  var n = parseFloat(String(configValue(key)).replace(',', '.'));
  return isNaN(n) ? parseFloat(CONFIG_DEFAULTS[key]) : n;
}
function configBool(key) {
  var v = configValue(key);
  return v === true || String(v).toUpperCase() === 'TRUE';
}

/** Имя общего свойства с токеном: META_TOKEN или SECRET_META_TOKEN — что найдётся. */
function defaultTokenKey_(platform) {
  var base = { meta: 'META_TOKEN', tiktok: 'TIKTOK_TOKEN', yandex: 'YANDEX_TOKEN' }[platform];
  if (prop_(base)) return base;
  if (prop_('SECRET_' + base)) return 'SECRET_' + base;
  return base;
}

/** Токен площадки для дилера: свой ключ из Registry или общий. */
function tokenFor(dealer, platform) {
  var key = String(dealer[platform + '_token_key'] || '').trim() || defaultTokenKey_(platform);
  var t = prop_(key);
  if (!t) throw new Error('В свойствах скрипта нет токена ' + key);
  return t;
}

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------
function registrySheet_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(HUB.REGISTRY_SHEET);
  if (!sh) throw new Error('Нет вкладки ' + HUB.REGISTRY_SHEET + ' — создай через меню «Создать вкладки»');
  return sh;
}

function readRegistry() {
  var data = registrySheet_().getDataRange().getValues();
  if (data.length < 2) return [];
  var head = data[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var d = { _row: i + 1 };
    head.forEach(function (h, c) { d[h] = data[i][c]; });
    if (String(d.dealer_id || '').trim()) {
      d.dealer_id = String(d.dealer_id).trim();
      out.push(d);
    }
  }
  return out;
}

function isActive_(d) {
  return d.active === true || String(d.active).toUpperCase() === 'TRUE' || String(d.active) === '1';
}
function activeDealers() { return readRegistry().filter(isActive_); }

function findDealer(id) {
  id = String(id).trim().toLowerCase();
  var list = readRegistry();
  for (var i = 0; i < list.length; i++) if (list[i].dealer_id.toLowerCase() === id) return list[i];
  return null;
}

/**
 * Пишет last_run / last_status и красит строку дилера.
 * isError не передан → ошибкой считается статус, начинающийся с "ERROR".
 */
function setRegistryStatus(dealer, status, isError) {
  if (isError === undefined) isError = /^ERROR/i.test(String(status));
  try {
    var sh = registrySheet_();
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    var cRun = head.indexOf('last_run') + 1, cSt = head.indexOf('last_status') + 1;
    if (cRun > 0) sh.getRange(dealer._row, cRun).setValue(new Date());
    if (cSt > 0) sh.getRange(dealer._row, cSt).setValue(String(status).substring(0, 500));
    paintRegistryRow_(sh, dealer._row, isError);
  } catch (e) { Logger.log('Не смог записать статус в Registry: ' + e.message); }
}

/** Цвет подсветки ошибки (из Config). */
function errColor_() {
  return String(configValue('ERROR_ROW_COLOR') || '#f4cccc').trim().toLowerCase();
}

/**
 * Ошибка → вся строка бледно-красная.
 * OK → снимаем ТОЛЬКО нашу подсветку (ячейки другого цвета, покрашенные вручную, не трогаем).
 */
function paintRegistryRow_(sh, row, isError) {
  var lastCol = Math.max(sh.getLastColumn(), REGISTRY_HEADERS.length);
  var rng = sh.getRange(row, 1, 1, lastCol);
  var color = errColor_();
  if (isError) { rng.setBackground(color); return; }
  var bgs = rng.getBackgrounds()[0];
  var changed = false;
  var out = bgs.map(function (c) {
    if (String(c).toLowerCase() === color) { changed = true; return '#ffffff'; }
    return c;
  });
  if (changed) rng.setBackgrounds([out]);
}

/** "a, b;c" → ['a','b','c'] */
function splitIds(v) {
  return String(v == null ? '' : v).split(/[,;\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// MAPPING (корректировки имён)
// ---------------------------------------------------------------------------
var MAPPING_CACHE_ = null;           // общие правила: { normName(старое): новое }
var ACCOUNT_MAPPING_CACHE_ = null;   // правила кабинетов: { аккаунт: { normName(старое): новое } }

/** Читает вкладку Mapping один раз за запуск: общие правила и правила по аккаунтам. */
function loadMapping_() {
  var common = {}, byAcc = {};
  var sh = SpreadsheetApp.getActive().getSheetByName(HUB.MAPPING_SHEET);
  if (sh) {
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var o = String(data[i][0] || '').trim(), n = String(data[i][1] || '').trim();
      if (!o || !n) continue;
      var accs = splitIds(data[i][2]).map(normAccountId);
      if (!accs.length) { common[normName(o)] = n; continue; }
      accs.forEach(function (a) {
        if (!byAcc[a]) byAcc[a] = {};
        byAcc[a][normName(o)] = n;
      });
    }
  }
  MAPPING_CACHE_ = common;
  ACCOUNT_MAPPING_CACHE_ = byAcc;
}

/** Общие правила (колонка C пустая) — применяются в 06_Pipeline после склейки кабинетов. */
function readMapping() {
  if (!MAPPING_CACHE_) loadMapping_();
  return MAPPING_CACHE_;
}
function mapCampaignName(name, mapping) {
  return mapping[normName(name)] || String(name).trim();
}

/** Правила по аккаунтам (колонка C заполнена). */
function readAccountMapping() {
  if (!ACCOUNT_MAPPING_CACHE_) loadMapping_();
  return ACCOUNT_MAPPING_CACHE_;
}

/** "act_123" / "123-456-7890" / " Login " → "123" / "1234567890" / "login" */
function normAccountId(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/^act_/, '').replace(/[-\s]/g, '');
}

/**
 * Имя кампании кабинета accountId после правила Mapping с этим аккаунтом.
 * Площадки вызывают ДО сложения кабинетов по имени. Нет правила — имя как есть.
 */
function mapCampaignForAccount(name, accountId) {
  var clean = String(name == null ? '' : name).trim();
  var rules = readAccountMapping()[normAccountId(accountId)];
  return (rules && rules[normName(clean)]) || clean;
}

// ---------------------------------------------------------------------------
// УТИЛИТЫ
// ---------------------------------------------------------------------------
function normName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}
function pad2_(n) { return n < 10 ? '0' + n : String(n); }
function makeDateStr(y, m, d) { return y + '-' + pad2_(m) + '-' + pad2_(d); }
function dispDate_(y, m, d) { return pad2_(d) + '.' + pad2_(m) + '.' + y; }

function rowHasData(impr, clicks, conv, cost) {
  if ((impr || 0) > configNum('MIN_IMPRESSIONS')) return true;
  return (cost || 0) > 0 || (conv || 0) > 0 || (clicks || 0) > 0;
}

function num_(v) {
  if (v === undefined || v === null) return 0;
  var s = String(v).replace(/\r/g, '').replace(/\s/g, '').replace(',', '.');
  if (s === '' || s === '--') return 0;
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// ПЕРИОДЫ
//   daily   — текущий месяц (1-е → вчера) + прошлый месяц, если сегодня ≤ PREV_MONTH_UNTIL_DAY
//   monthly — прошлый месяц целиком
// ---------------------------------------------------------------------------
function periodForMonth_(y, m, lastDayDate) {           // m: 0..11
  var last = lastDayDate || new Date(y, m + 1, 0);
  return {
    header: 'месяц ' + HUB.MONTHS[m],
    dFrom: makeDateStr(y, m + 1, 1),
    dTo:   makeDateStr(last.getFullYear(), last.getMonth() + 1, last.getDate()),
    disp:  dispDate_(last.getFullYear(), last.getMonth() + 1, last.getDate())
  };
}

function buildPeriods(mode) {
  var now = new Date();
  var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var y = yesterday.getFullYear(), m = yesterday.getMonth();
  var periods = [];
  if (mode === 'monthly') {
    var pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    periods.push(periodForMonth_(pm.getFullYear(), pm.getMonth()));
    return periods;
  }
  if (yesterday.getDate() <= configNum('PREV_MONTH_UNTIL_DAY')) {
    var prev = new Date(y, m - 1, 1);
    periods.push(periodForMonth_(prev.getFullYear(), prev.getMonth()));
  }
  periods.push(periodForMonth_(y, m, yesterday));
  return periods;
}

/** Произвольный месяц: customPeriod(2026, 4) → апрель 2026 целиком. */
function customPeriod(year, month1to12) {
  return [periodForMonth_(year, month1to12 - 1)];
}

// ---------------------------------------------------------------------------
// LOG
// ---------------------------------------------------------------------------
function logRow(dealerId, period, platform, rows, spend, status) {
  try {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(HUB.LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(HUB.LOG_SHEET);
      sh.appendRow(['Время', 'Дилер', 'Период', 'Площадка', 'Строк', 'Расход', 'Статус']);
    }
    sh.appendRow([new Date(), dealerId, period, platform, rows, spend, String(status).substring(0, 1000)]);
    if (sh.getLastRow() > 5000) sh.deleteRows(2, 1000);   // не даём логу расти бесконечно
  } catch (e) { Logger.log('Лог не записан: ' + e.message); }
  Logger.log('[' + dealerId + '] ' + period + ' ' + platform + ': ' + rows + ' строк, расход ' + spend + ' — ' + status);
}