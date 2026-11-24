/**
 * 11_Errors.gs — ЖУРНАЛ ОШИБОК, ПОДСВЕТКА REGISTRY, TELEGRAM.
 *
 * Вызывается из 06_Pipeline после каждого дилера:
 *   reportDealerErrors_(dealer, errors) — журнал + Telegram (были ошибки)
 *   reportDealerRecovered_(dealer, note) — Telegram «снова OK» (раньше была ошибка)
 *
 * «Журнал ошибок» — новые записи сверху:
 *   Время | Тип | dealer_id | Бренд | Площадка | Аккаунт | Период | Причина |
 *   Как исправить | Текст ошибки | Что в МП | Registry (ссылка на строку)
 *   Одинаковые ошибки одного дилера за разные месяцы склеиваются в одну строку.
 *
 * Telegram — одно сообщение на дилера со всеми его ошибками.
 *   Свойства скрипта: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (можно несколько через запятую).
 *   Config: TG_ENABLED, TG_REPEAT_HOURS (одинаковая ошибка не повторяется чаще),
 *           TG_NOTIFY_RECOVERY.
 *
 * Меню (08_Menu): проверить Telegram, узнать chat_id, открыть/очистить журнал,
 * перекрасить Registry по last_status.
 */

var ERR = {
  SHEET: 'Журнал ошибок',
  HEADERS: ['Время', 'Тип', 'dealer_id', 'Бренд', 'Площадка', 'Аккаунт', 'Период',
            'Причина', 'Как исправить', 'Текст ошибки', 'Что в МП', 'Registry'],
  SENT_KEY: 'TG_SENT_ERRORS',
  WIDTHS: [130, 110, 230, 120, 95, 170, 150, 330, 420, 380, 260, 90]
};

// ---------------------------------------------------------------------------
// ПРАВИЛА: текст ошибки → причина и как исправить
//   p  — площадки, к которым относится правило (null — любая)
//   re — что ищем в тексте ошибки
// Порядок важен: срабатывает первое подходящее правило.
// ---------------------------------------------------------------------------
var ERR_RULES = [
  // --- общие настройки ---
  { id: 'no_token', p: null, re: /нет токена/i,
    reason: 'В свойствах скрипта нет токена, который ищет выгрузка.',
    fix: 'Настройки проекта → Свойства скрипта → добавь ключ из текста ошибки (например SECRET_YANDEX_TOKEN). Если у дилера свой токен — имя в колонке *_token_key Registry должно совпадать с именем свойства буква в букву.' },

  // --- Yandex ---
  { id: 'ya_204', p: ['Yandex'], re: /HTTP 204/,
    reason: 'Директ вернул HTTP 204 «No Content» — данные не отданы (Директ недоступен или за период нет статистики).',
    fix: 'Строки Yandex в МП не удалены — остались с прошлой выгрузки и обновятся сами, когда Директ заработает. Чтобы 204 не считался ошибкой, поставь в Config YANDEX_204_MODE = KEEP. Подробности ответа — yandexDiag(\'dealer_id\', \'ГГГГ-ММ-ДД\', \'ГГГГ-ММ-ДД\').' },
  { id: 'ya_auth', p: ['Yandex'], re: /код (53|58)\b|Ошибка авторизации|Authorization error|invalid_token/i,
    reason: 'Токен Яндекса недействителен: истёк, отозван или выдан другому аккаунту.',
    fix: 'Проверь токен в свойстве SECRET_YANDEX_TOKEN / YANDEX_TOKEN (или в ключе из yandex_token_key). Токен должен быть выдан агентскому аккаунту, у которого есть этот клиент. Токен Директа живёт около года.' },
  { id: 'ya_login', p: ['Yandex'], re: /код (54|513|3000|3001|8800)\b|не является клиентом|not a client|не подключен|not enabled|Объект не найден|Нет прав/i,
    reason: 'У токена нет доступа к этому клиенту: логин указан с ошибкой, клиент не в агентском кабинете или у логина нет Директа.',
    fix: 'Сверь yandex_client_login с логином в агентском кабинете Директа (Клиенты → логин). Если клиент ведётся с другого агентства — нужен его токен: положи в свойства и укажи имя в yandex_token_key.' },
  { id: 'ya_units', p: ['Yandex'], re: /код 152\b|баллов|units/i,
    reason: 'Закончились баллы API Директа на сегодня.',
    fix: 'Ничего не ломать: баллы восстановятся в течение часа/суток. Перезапусти дилера позже (меню → «Выгрузить одного дилера»). Если повторяется ежедневно — разнеси выгрузку по времени.' },
  { id: 'ya_queue', p: ['Yandex'], re: /код 9000\b|очеред|queue/i,
    reason: 'Переполнена очередь офлайн-отчётов Директа у этого клиента.',
    fix: 'Подожди 5–10 минут и перезапусти дилера. Не запускай одновременно несколько выгрузок одного логина.' },
  { id: 'ya_timeout', p: ['Yandex'], re: /не сформировался/i,
    reason: 'Директ не успел сформировать отчёт за 8 попыток ожидания (~4 минуты).',
    fix: 'Перезапусти дилера позже. Если повторяется — выгружай этот месяц отдельно (меню → «выбрать месяц»).' },
  { id: 'ya_params', p: ['Yandex'], re: /HTTP 400|код (4000|4001|4002|8000)\b|Goals|AttributionModels/i,
    reason: 'Директ отклонил параметры отчёта — чаще всего цель из yandex_goal_ids не относится к счётчику Метрики этих кампаний или ID цели с ошибкой.',
    fix: 'Проверь yandex_goal_ids: только числа через запятую, цели должны быть в счётчике, привязанном к кампаниям клиента. Для проверки очисти ячейку целей и перезапусти — если ошибка уйдёт, дело в цели.' },
  { id: 'ya_server', p: ['Yandex'], re: /HTTP (429|5\d\d)/,
    reason: 'Временная ошибка серверов Директа или лимит запросов.',
    fix: 'Ничего менять не нужно — перезапусти дилера через 15–30 минут.' },

  // --- Meta ---
  { id: 'meta_token', p: ['Meta'], re: /"code":\s*190\b|Session has expired|Error validating access token|has expired/i,
    reason: 'Токен Meta истёк или отозван (код 190).',
    fix: 'Выпусти новый токен системного пользователя в Business Manager (с правом ads_read, без срока действия) и замени значение SECRET_META_TOKEN (или ключа из meta_token_key). Проверка — меню «Проверить токены».' },
  { id: 'meta_rate', p: ['Meta'], re: /"code":\s*(4|17|32|613|80000|80004)\b|too many calls|request limit/i,
    reason: 'Превышен лимит запросов Meta API для кабинета или приложения.',
    fix: 'Подожди 30–60 минут и перезапусти дилера. Если повторяется — не запускай выгрузку всех дилеров несколько раз подряд.' },
  { id: 'meta_perm', p: ['Meta'], re: /"code":\s*(10|200|272|275|294)\b|does not have permission|Missing permissions|not authorized|Unsupported get request/i,
    reason: 'У токена нет доступа к рекламному кабинету (или кабинет с таким ID не существует).',
    fix: 'Business Manager → Пользователи → Системные пользователи → «Назначить объекты» → добавь этот рекламный кабинет с доступом «Просмотр результатов». Сверь meta_act_ids с ID кабинета в Ads Manager.' },
  { id: 'meta_param', p: ['Meta'], re: /"code":\s*100\b/,
    reason: 'Meta отклонила параметр запроса — чаще всего неверный ID кабинета в meta_act_ids.',
    fix: 'Проверь meta_act_ids: только цифры (act_ можно не писать), без пробелов внутри, несколько — через запятую.' },
  { id: 'meta_data', p: ['Meta'], re: /reduce the amount of data|"code":\s*1\b/i,
    reason: 'Meta не смогла отдать такой объём данных за раз.',
    fix: 'Перезапусти дилера позже. Если повторяется — выгружай месяцы по одному.' },
  { id: 'meta_temp', p: ['Meta'], re: /"is_transient":\s*true|"code":\s*2\b|unexpected error/i,
    reason: 'Временная ошибка серверов Meta.',
    fix: 'Ничего менять не нужно — перезапусти дилера через 15–30 минут.' },

  // --- TikTok ---
  { id: 'tt_rate', p: ['TikTok'], re: /40100|too frequent|rate limit|QPS/i,
    reason: 'Превышен лимит запросов TikTok API.',
    fix: 'Подожди 10–15 минут и перезапусти дилера.' },
  { id: 'tt_token', p: ['TikTok'], re: /4010[2-5]|access.?token/i,
    reason: 'Токен TikTok истёк, отозван или неверный.',
    fix: 'Получи новый Access Token в TikTok for Business (Developers → приложение → авторизация) и замени SECRET_TIKTOK_TOKEN (или ключ из tiktok_token_key).' },
  { id: 'tt_adv', p: ['TikTok'], re: /40001|40002|advertiser|no permission|permission/i,
    reason: 'advertiser_id не авторизован для этого токена или указан с ошибкой.',
    fix: 'Сверь tiktok_adv_ids с ID в TikTok Ads Manager (только цифры). Если ID верный — переавторизуй приложение и отметь в списке этот рекламный аккаунт, либо выдай доступ через Business Center.' },
  { id: 'tt_server', p: ['TikTok'], re: /\b5\d{4}\b|internal/i,
    reason: 'Временная ошибка серверов TikTok.',
    fix: 'Ничего менять не нужно — перезапусти дилера через 15–30 минут.' },

  // --- Google Ads ---
  { id: 'g_props', p: ['Google'], re: /Заполни GADS_/,
    reason: 'В свойствах скрипта не заполнены GADS_MCC_ID или GADS_DEVELOPER_TOKEN.',
    fix: 'Настройки проекта → Свойства скрипта: GADS_MCC_ID (ID управляющего аккаунта), GADS_DEVELOPER_TOKEN, GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN.' },
  { id: 'g_grant', p: ['Google'], re: /invalid_grant/i,
    reason: 'Refresh token Google отозван или истёк.',
    fix: 'Выпусти новый GADS_REFRESH_TOKEN тем же Google-аккаунтом, у которого есть доступ к MCC. Если токен «умирает» каждые 7 дней — OAuth-приложение в Google Cloud в статусе Testing: переведи его в In production.' },
  { id: 'g_client', p: ['Google'], re: /invalid_client|unauthorized_client/i,
    reason: 'Неверные GADS_CLIENT_ID / GADS_CLIENT_SECRET.',
    fix: 'Скопируй заново Client ID и Client Secret из Google Cloud → APIs & Services → Credentials (того же OAuth-клиента, которым выпущен refresh token).' },
  { id: 'g_devtoken', p: ['Google'], re: /DEVELOPER_TOKEN_(NOT_APPROVED|PROHIBITED|INVALID)|test account/i,
    reason: 'Developer token не одобрен для рабочих аккаунтов или неверный.',
    fix: 'Проверь в MCC → Инструменты → Центр API уровень доступа токена (нужен Basic/Standard) и значение GADS_DEVELOPER_TOKEN.' },
  { id: 'g_perm', p: ['Google'], re: /USER_PERMISSION_DENIED|PERMISSION_DENIED|CUSTOMER_NOT_FOUND|API 403|does not have permission/i,
    reason: 'Аккаунт Google Ads не привязан к MCC из GADS_MCC_ID, или у пользователя refresh token нет к нему доступа.',
    fix: 'Проверь, что аккаунт из google_customer_id есть в MCC (Аккаунты → в списке). Сверь ID: 10 цифр, можно с дефисами. Если аккаунт в другом MCC — он не выгрузится этим токеном.' },
  { id: 'g_disabled', p: ['Google'], re: /CUSTOMER_NOT_ENABLED|CUSTOMER_NOT_ACTIVE|deactivated|not yet enabled|CANCELED/i,
    reason: 'Аккаунт Google Ads отключён, отменён или ещё не активирован.',
    fix: 'Открой аккаунт в Google Ads: если он закрыт — убери его ID из google_customer_id у дилера.' },
  { id: 'g_version', p: ['Google'], re: /UNSUPPORTED_VERSION|API 404|deprecated|sunset/i,
    reason: 'Версия Google Ads API из Config (GADS_API_VERSION) отключена Google.',
    fix: 'Подними GADS_API_VERSION во вкладке Config на актуальную (смотри developers.google.com/google-ads/api/docs/sunset-dates).' },
  { id: 'g_quota', p: ['Google'], re: /RESOURCE_EXHAUSTED|RATE_EXCEEDED|API 429/i,
    reason: 'Исчерпан лимит запросов Google Ads API.',
    fix: 'Перезапусти дилера через 30–60 минут. При частых повторах — проверь уровень developer token.' },
  { id: 'g_auth', p: ['Google'], re: /UNAUTHENTICATED|API 401|Google OAuth/i,
    reason: 'Google не принял авторизацию (токен доступа не получен).',
    fix: 'Проверь GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN в свойствах скрипта; меню «Проверить токены».' },
  { id: 'g_query', p: ['Google'], re: /QUERY_ERROR|INVALID_ARGUMENT|API 400|INVALID_CUSTOMER_ID/i,
    reason: 'Google отклонил запрос — чаще всего неверный формат google_customer_id.',
    fix: 'В google_customer_id — 10 цифр (123-456-7890 или 1234567890), несколько через запятую.' },
  { id: 'g_server', p: ['Google'], re: /API 5\d\d|INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED/i,
    reason: 'Временная ошибка серверов Google Ads.',
    fix: 'Ничего менять не нужно — перезапусти дилера через 15–30 минут.' },

  // --- запись в МП ---
  { id: 'mp_noid', p: null, re: /не указан mp_spreadsheet_id/i,
    reason: 'В Registry у дилера пустой mp_spreadsheet_id.',
    fix: 'Вставь в колонку mp_spreadsheet_id ID таблицы МП (часть ссылки между /d/ и /edit).' },
  { id: 'mp_access', p: ['Запись в МП'], re: /permission|разрешени|доступ|Access denied|not found|не найден|Requested entity|missing|отсутствует/i,
    reason: 'Нет доступа к таблице МП или таблица удалена / ID неверный.',
    fix: 'Открой МП по ID из mp_spreadsheet_id. Дай владельцу скрипта Hub права редактора. Если таблицу пересоздали — обнови ID в Registry.' },
  { id: 'mp_cells', p: ['Запись в МП'], re: /10000000|ячеек|cells/i,
    reason: 'В таблице МП достигнут лимит 10 млн ячеек.',
    fix: 'Удали в МП лишние вкладки или пустые строки/столбцы.' },

  // --- общие технические ---
  { id: 'net', p: null, re: /Address unavailable|DNS error|timed? ?out|Timeout|Время ожидания|Connection reset|Exception: Request failed/i,
    reason: 'Сетевая ошибка: площадка не ответила вовремя.',
    fix: 'Ничего менять не нужно — перезапусти дилера позже.' },
  { id: 'gas_quota', p: null, re: /Service invoked too many times|Bandwidth quota|слишком много раз|urlfetch/i,
    reason: 'Исчерпана суточная квота Apps Script на внешние запросы (UrlFetch).',
    fix: 'Квота обнулится через сутки. Не запускай «всех дилеров» несколько раз в день вручную.' },
  { id: 'json', p: null, re: /Unexpected token|JSON|Unterminated|SyntaxError/i,
    reason: 'Площадка вернула не JSON — обычно HTML-страницу ошибки или обрыв ответа.',
    fix: 'Обычно временное — перезапусти дилера. Если повторяется — пришли текст ошибки.' },
  { id: 'gas_time', p: null, re: /maximum execution time|максимальное время/i,
    reason: 'Запуск Apps Script превысил 6 минут.',
    fix: 'Очередь продолжит сама. Если это ручной запуск одного дилера — выгружай месяцы по одному.' }
];

var ERR_UNKNOWN = {
  id: 'unknown',
  reason: 'Неизвестная ошибка — автоматического объяснения нет.',
  fix: 'Посмотри «Текст ошибки»: в нём ответ площадки. Если непонятно — скопируй текст и разберём.'
};

function classifyError_(platform, message) {
  var msg = String(message || '');
  for (var i = 0; i < ERR_RULES.length; i++) {
    var r = ERR_RULES[i];
    if (r.p && r.p.indexOf(platform) === -1) continue;
    if (r.re.test(msg)) return r;
  }
  return ERR_UNKNOWN;
}

// ---------------------------------------------------------------------------
// ДИЛЕР: тип, аккаунт, группировка
// ---------------------------------------------------------------------------
function dealerKind_(id) {
  var s = String(id || '').toLowerCase();
  if (s.indexOf('distr') === 0) return 'Дистрибьютор';
  if (s.indexOf('dealer') === 0) return 'Дилер';
  return 'Аккаунт';
}

function fmtGoogleId_(id) {
  var s = String(id).replace(/\D/g, '');
  return s.length === 10 ? s.substr(0, 3) + '-' + s.substr(3, 3) + '-' + s.substr(6) : s;
}

/** Какой именно кабинет упал: из текста ошибки, иначе всё, что указано в Registry. */
function accountFromError_(dealer, platform, msg) {
  var m;
  msg = String(msg || '');
  if (platform === 'Google' && (m = /аккаунт (\d{10})/.exec(msg))) return fmtGoogleId_(m[1]);
  if (platform === 'Meta'   && (m = /act_(\d+)/.exec(msg)))        return 'act_' + m[1];
  if (platform === 'TikTok' && (m = /TikTok (\d{6,})/.exec(msg)))   return m[1];
  if (platform === 'Yandex' && (m = /Yandex ([^\s:,]+)/.exec(msg))) return m[1];
  var col = { Google: 'google_customer_id', Meta: 'meta_act_ids', TikTok: 'tiktok_adv_ids',
              Yandex: 'yandex_client_login' }[platform];
  if (platform === 'Запись в МП') col = 'mp_spreadsheet_id';
  if (!col) return '';
  var ids = splitIds(dealer[col]);
  return platform === 'Google' ? ids.map(fmtGoogleId_).join(', ') : ids.join(', ');
}

/** Одинаковые ошибки (площадка + аккаунт + причина) за разные месяцы — одной записью. */
function groupErrors_(dealer, errors) {
  var map = {}, order = [];
  errors.forEach(function (e) {
    var rule = classifyError_(e.platform, e.message);
    var acc = accountFromError_(dealer, e.platform, e.message);
    var key = e.platform + '|' + acc + '|' + rule.id;
    if (!map[key]) {
      map[key] = { key: key, platform: e.platform, account: acc, rule: rule,
                   periods: [], message: e.message, mp: [] };
      order.push(key);
    }
    var g = map[key];
    if (e.period && g.periods.indexOf(e.period) === -1) g.periods.push(e.period);
    if (e.mp && g.mp.indexOf(e.mp) === -1) g.mp.push(e.mp);
  });
  return order.map(function (k) { return map[k]; });
}

// ---------------------------------------------------------------------------
// ТОЧКИ ВХОДА ИЗ 06_Pipeline
// ---------------------------------------------------------------------------
function reportDealerErrors_(dealer, errors) {
  var groups = groupErrors_(dealer, errors);
  try { journalWrite_(dealer, groups); }
  catch (e) { Logger.log('Журнал ошибок не записан: ' + e.message); }
  tgDealerErrors_(dealer, groups);
}

function reportDealerRecovered_(dealer, note) {
  if (!/^ERROR/i.test(String(dealer.last_status || ''))) return;   // ошибки не было
  tgForgetDealer_(dealer.dealer_id);
  if (!configBool('TG_ENABLED') || !configBool('TG_NOTIFY_RECOVERY')) return;
  tgSend_('✅ <b>Autoreport Hub: снова OK</b>\n' +
          dealerKind_(dealer.dealer_id) + ': <b>' + tgEsc_(dealer.dealer_id) + '</b>' +
          (dealer.brand ? ' (' + tgEsc_(dealer.brand) + ')' : '') + '\n' +
          'Выгрузка прошла без ошибок, подсветка в Registry снята.' +
          (note ? '\nℹ️ ' + tgEsc_(note) : ''));
}

// ---------------------------------------------------------------------------
// ВКЛАДКА «Журнал ошибок»
// ---------------------------------------------------------------------------
function journalSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(ERR.SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(ERR.SHEET);
  sh.getRange(1, 1, 1, ERR.HEADERS.length).setValues([ERR.HEADERS])
    .setFontWeight('bold').setBackground('#f1f3f4').setWrap(true).setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  ERR.WIDTHS.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  return sh;
}

function registryLink_(dealer) {
  try {
    var gid = registrySheet_().getSheetId();
    return '=HYPERLINK("#gid=' + gid + '&range=A' + dealer._row + '";"строка ' + dealer._row + '")';
  } catch (e) { return ''; }
}

function journalWrite_(dealer, groups) {
  if (!groups.length) return;
  var sh = journalSheet_();
  var now = new Date();
  var link = registryLink_(dealer);
  var rows = groups.map(function (g) {
    return [now, dealerKind_(dealer.dealer_id), dealer.dealer_id, String(dealer.brand || ''),
            g.platform, g.account, g.periods.join(', '),
            g.rule.reason, g.rule.fix, String(g.message).substring(0, 2000),
            g.mp.join('; '), link];
  });
  sh.insertRowsAfter(1, rows.length);
  var rng = sh.getRange(2, 1, rows.length, ERR.HEADERS.length);
  rng.setValues(rows)
     .setFontWeight('normal').setBackground('#ffffff')
     .setWrap(true).setVerticalAlignment('top');
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  sh.getRange(2, 5, rows.length, 1).setFontWeight('bold');

  var limit = configNum('ERROR_JOURNAL_LIMIT') || 3000;
  var extra = sh.getLastRow() - 1 - limit;
  if (extra > 0) sh.deleteRows(limit + 2, extra);
}

// ---------------------------------------------------------------------------
// TELEGRAM
// ---------------------------------------------------------------------------
function tgEsc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Отправка HTML-сообщения во все chat_id. → {ok, error} */
function tgSend_(html) {
  var token = String(prop_('TELEGRAM_BOT_TOKEN') || '').trim();
  var chats = splitIds(prop_('TELEGRAM_CHAT_ID'));
  if (!token || !chats.length) {
    Logger.log('Telegram: не заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — сообщение не отправлено');
    return { ok: false, error: 'не заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID в свойствах скрипта' };
  }
  var text = html.length > 4000 ? html.substring(0, 3990) + '…' : html;
  var errs = [];
  chats.forEach(function (chat) {
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ chat_id: chat, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
        });
        var j = JSON.parse(res.getContentText());
        if (j.ok) return;
        if (j.error_code === 429) {
          var wait = (j.parameters && j.parameters.retry_after) || 3;
          Utilities.sleep(Math.min(wait, 30) * 1000);
          continue;
        }
        if (/can't parse entities/i.test(j.description || '')) {   // сломалась разметка — шлём без HTML
          var plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
            method: 'post', contentType: 'application/json', muteHttpExceptions: true,
            payload: JSON.stringify({ chat_id: chat, text: plain, disable_web_page_preview: true })
          });
          return;
        }
        errs.push(chat + ': ' + (j.description || res.getContentText().substring(0, 200)));
        return;
      } catch (e) {
        if (attempt === 3) errs.push(chat + ': ' + e.message);
        else Utilities.sleep(2000);
      }
    }
  });
  if (errs.length) Logger.log('Telegram: ' + errs.join(' | '));
  return { ok: !errs.length, error: errs.join(' | ') };
}

function tgSentMap_() {
  try { return JSON.parse(prop_(ERR.SENT_KEY) || '{}'); } catch (e) { return {}; }
}
function tgSaveSentMap_(map) {
  var now = Date.now(), week = 7 * 864e5;
  Object.keys(map).forEach(function (k) { if (now - map[k] > week) delete map[k]; });
  try { PropertiesService.getScriptProperties().setProperty(ERR.SENT_KEY, JSON.stringify(map)); }
  catch (e) { Logger.log('Telegram: не сохранил список отправленных: ' + e.message); }
}
function tgForgetDealer_(dealerId) {
  var map = tgSentMap_(), pref = dealerId + '|', changed = false;
  Object.keys(map).forEach(function (k) { if (k.indexOf(pref) === 0) { delete map[k]; changed = true; } });
  if (changed) tgSaveSentMap_(map);
}

function tgDealerErrors_(dealer, groups) {
  if (!configBool('TG_ENABLED') || !groups.length) return;

  // не повторяем одну и ту же ошибку чаще TG_REPEAT_HOURS
  var hours = configNum('TG_REPEAT_HOURS');
  var sent = tgSentMap_(), now = Date.now();
  var fresh = groups.filter(function (g) {
    var k = dealer.dealer_id + '|' + g.key;
    return !(hours > 0 && sent[k] && now - sent[k] < hours * 3600000);
  });
  if (!fresh.length) {
    Logger.log('[' + dealer.dealer_id + '] Telegram: те же ошибки уже отправлялись за последние ' + hours + ' ч');
    return;
  }

  var url = SpreadsheetApp.getActive().getUrl();
  var jGid = '';
  try { jGid = journalSheet_().getSheetId(); } catch (e) {}

  var parts = [];
  parts.push('🔴 <b>Autoreport Hub: ошибка выгрузки</b>');
  parts.push(dealerKind_(dealer.dealer_id) + ': <b>' + tgEsc_(dealer.dealer_id) + '</b>' +
             (dealer.brand ? ' (' + tgEsc_(dealer.brand) + ')' : ''));
  parts.push('Площадок с ошибкой: ' + fresh.length);

  fresh.slice(0, 8).forEach(function (g, i) {
    parts.push('');
    parts.push('<b>' + (i + 1) + '. ' + tgEsc_(g.platform) + '</b>' +
               (g.account ? ' · аккаунт <code>' + tgEsc_(g.account) + '</code>' : ''));
    if (g.periods.length) parts.push('Период: ' + tgEsc_(g.periods.join(', ')));
    parts.push('Причина: ' + tgEsc_(g.rule.reason));
    parts.push('Как исправить: ' + tgEsc_(g.rule.fix));
    if (g.mp.length) parts.push('В МП: ' + tgEsc_(g.mp.join('; ')));
    parts.push('<i>' + tgEsc_(String(g.message).substring(0, 400)) + '</i>');
  });
  if (fresh.length > 8) parts.push('\n…и ещё ' + (fresh.length - 8) + ' — смотри журнал.');

  parts.push('');
  parts.push('<a href="' + url + (jGid !== '' ? '#gid=' + jGid : '') + '">Журнал ошибок</a> · ' +
             'Registry, строка ' + dealer._row);

  var r = tgSend_(parts.join('\n'));
  if (r.ok) {
    fresh.forEach(function (g) { sent[dealer.dealer_id + '|' + g.key] = now; });
    tgSaveSentMap_(sent);
  }
}

// ---------------------------------------------------------------------------
// ПУНКТЫ МЕНЮ
// ---------------------------------------------------------------------------
function menuTelegramTest() {
  var ui = SpreadsheetApp.getUi();
  var r = tgSend_('✅ <b>Autoreport Hub</b>\nТестовое сообщение: уведомления об ошибках выгрузки будут приходить сюда.');
  ui.alert(r.ok ? 'Сообщение отправлено — проверь Telegram.' : 'Не отправлено:\n' + r.error);
}

/** Показывает chat_id из последних сообщений боту и предлагает сохранить. */
function menuTelegramChatId() {
  var ui = SpreadsheetApp.getUi();
  var token = String(prop_('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) { ui.alert('Сначала добавь TELEGRAM_BOT_TOKEN в Свойства скрипта (токен от @BotFather).'); return; }
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  var j = JSON.parse(res.getContentText());
  if (!j.ok) { ui.alert('Telegram ответил ошибкой:\n' + (j.description || res.getContentText().substring(0, 300))); return; }

  var chats = {};
  (j.result || []).forEach(function (u) {
    var m = u.message || u.channel_post || u.my_chat_member || u.edited_message;
    var c = m && m.chat;
    if (c) chats[c.id] = (c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '') + ' [' + c.type + ']';
  });
  var ids = Object.keys(chats);
  if (!ids.length) {
    ui.alert('Боту пока никто не писал.\nОткрой бота в Telegram, нажми Start (или напиши любое сообщение), затем запусти этот пункт ещё раз.\nДля группы — добавь бота в группу и напиши в ней сообщение.');
    return;
  }
  var list = ids.map(function (id) { return id + ' — ' + chats[id]; }).join('\n');
  var ans = ui.alert('Найденные чаты', list + '\n\nСохранить ' + (ids.length === 1 ? 'этот chat_id' : 'ВСЕ эти chat_id') +
                     ' в TELEGRAM_CHAT_ID?', ui.ButtonSet.YES_NO);
  if (ans === ui.Button.YES) {
    PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_ID', ids.join(','));
    ui.alert('Сохранено: TELEGRAM_CHAT_ID = ' + ids.join(',') + '\nТеперь — «Telegram: тестовое сообщение».');
  }
}

function menuOpenErrorJournal() {
  SpreadsheetApp.getActive().setActiveSheet(journalSheet_());
}

function menuClearErrorJournal() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Очистить «' + ERR.SHEET + '»?', 'Все записи будут удалены.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var sh = journalSheet_();
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  PropertiesService.getScriptProperties().deleteProperty(ERR.SENT_KEY);
  ui.alert('Журнал очищен.');
}

/** Красит строки Registry по текущему last_status: ERROR → бледно-красный, иначе — снять. */
function menuRepaintRegistry() {
  var sh = registrySheet_();
  var data = sh.getDataRange().getValues();
  var head = data[0].map(function (h) { return String(h).trim(); });
  var c = head.indexOf('last_status');
  if (c < 0) { SpreadsheetApp.getUi().alert('В Registry нет колонки last_status'); return; }
  var red = 0;
  for (var i = 1; i < data.length; i++) {
    if (!String(data[i][0] || '').trim()) continue;
    var isErr = /^ERROR/i.test(String(data[i][c]));
    paintRegistryRow_(sh, i + 1, isErr);
    if (isErr) red++;
  }
  SpreadsheetApp.getUi().alert('Готово. Подсвечено строк с ошибкой: ' + red);
}