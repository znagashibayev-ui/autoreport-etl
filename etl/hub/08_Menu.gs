/**
 * 08_Menu.gs — меню в таблице Hub.
 *
 * ИЗМЕНЕНО:
 *   • Подменю «Ошибки и Telegram»: журнал, перекраска Registry, проверка Telegram, chat_id.
 *   • «0. Создать вкладки» теперь создаёт «Журнал ошибок» и дописывает в Config новые
 *     параметры, которых там ещё нет (существующие значения не трогает).
 *   • Ручной запуск одного дилера показывает, какие площадки упали и почему,
 *     остальные площадки при этом уже записаны в МП.
 *   • …и какие площадки не отдали данные (Яндекс 204) — их строки в МП оставлены как были.
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Autoreport Hub')
    .addItem('0. Создать вкладки (Registry / Mapping / Config / Log / Журнал ошибок)', 'menuSetupSheets')
    .addItem('1. Проверить токены', 'menuCheckTokens')
    .addSeparator()
    .addItem('2. Выгрузить одного дилера — текущий месяц', 'menuRunOneDaily')
    .addItem('2. Выгрузить одного дилера — выбрать месяц', 'menuRunOneMonth')
    .addItem('3. Создать вкладку Ads Data во всех МП', 'menuCreateTargetSheets')
    .addItem('Собрать цели Google Ads (активный лист, колонка A)', 'menuListGoogleConversions')
    .addSeparator()
    .addItem('▶ Запустить ВСЕХ (текущий месяц)', 'menuRunAllDaily')
    .addItem('▶ Запустить ВСЕХ (прошлый месяц)', 'menuRunAllMonthly')
    .addItem('▶ Запустить ВСЕХ — выбрать месяцы…', 'menuRunAllCustom')
    .addItem('Продолжить очередь вручную', 'hubProcessQueue')
    .addItem('Показать прогресс', 'menuShowQueue')
    .addSeparator()
    .addSubMenu(ui.createMenu('Ошибки и Telegram')
      .addItem('Открыть «Журнал ошибок»', 'menuOpenErrorJournal')
      .addItem('Перекрасить Registry по last_status', 'menuRepaintRegistry')
      .addItem('Очистить «Журнал ошибок»', 'menuClearErrorJournal')
      .addSeparator()
      .addItem('Telegram: узнать и сохранить chat_id', 'menuTelegramChatId')
      .addItem('Telegram: тестовое сообщение', 'menuTelegramTest'))
    .addSeparator()
    .addItem('Установить триггеры', 'menuInstallTriggers')
    .addItem('Удалить триггеры', 'menuRemoveTriggers')
    .addToUi();
}

// ---------------------------------------------------------------------------
function menuSetupSheets() {
  var ss = SpreadsheetApp.getActive();

  var reg = ss.getSheetByName(HUB.REGISTRY_SHEET) || ss.insertSheet(HUB.REGISTRY_SHEET);
  if (reg.getLastRow() === 0) {
    reg.getRange(1, 1, 1, REGISTRY_HEADERS.length).setValues([REGISTRY_HEADERS]).setFontWeight('bold');
    reg.getRange(2, 1, 1, REGISTRY_HEADERS.length).setValues([[
      'BYD', 'BYD Kazakhstan', 'TRUE',
      '14lNxgQzTbSgsggyTp8sA8SXtdvAdYkueFq69EmGrLcc', 'Ads Data',
      '', 'form_send, uniq_call', 'start',
      '1404746167669355', '',
      '7599973235241025552', '',
      'porg-xshmlj3c', '513995558', '',
      '', ''
    ]]);
    reg.setFrozenRows(1);
  }

  var map = ss.getSheetByName(HUB.MAPPING_SHEET) || ss.insertSheet(HUB.MAPPING_SHEET);
  if (map.getLastRow() === 0) {
    map.getRange(1, 1, 1, 2).setValues([['Старое название', 'Новое название']]).setFontWeight('bold');
    map.setFrozenRows(1);
  }

  var cfg = ss.getSheetByName(HUB.CONFIG_SHEET) || ss.insertSheet(HUB.CONFIG_SHEET);
  var addedCfg = [];
  if (cfg.getLastRow() === 0) {
    var rows = [['Параметр', 'Значение']];
    Object.keys(CONFIG_DEFAULTS).forEach(function (k) { rows.push([k, CONFIG_DEFAULTS[k]]); });
    cfg.getRange(1, 1, rows.length, 2).setValues(rows);
    cfg.getRange(1, 1, 1, 2).setFontWeight('bold');
  } else {
    // дописываем только новые параметры, значения существующих не трогаем
    var have = {};
    cfg.getDataRange().getValues().forEach(function (r) { have[String(r[0]).trim()] = true; });
    var add = [];
    Object.keys(CONFIG_DEFAULTS).forEach(function (k) { if (!have[k]) add.push([k, CONFIG_DEFAULTS[k]]); });
    if (add.length) {
      cfg.getRange(cfg.getLastRow() + 1, 1, add.length, 2).setValues(add);
      addedCfg = add.map(function (a) { return a[0]; });
    }
  }

  var log = ss.getSheetByName(HUB.LOG_SHEET) || ss.insertSheet(HUB.LOG_SHEET);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, 7).setValues([['Время', 'Дилер', 'Период', 'Площадка', 'Строк', 'Расход', 'Статус']]).setFontWeight('bold');
    log.setFrozenRows(1);
  }

  journalSheet_();

  SpreadsheetApp.getUi().alert('Вкладки готовы. Заполни Registry (первая строка — пример для BYD) и проверь Config.' +
    (addedCfg.length ? '\n\nВ Config добавлены новые параметры:\n' + addedCfg.join('\n') : ''));
}

// ---------------------------------------------------------------------------
function menuCheckTokens() {
  var lines = [];
  var dealers = readRegistry();
  var first = dealers[0] || {};

  try { lines.push('Google Ads: ' + gadsSelfCheck_()); } catch (e) { lines.push('Google Ads: ❌ ' + e.message); }

  ['meta', 'tiktok', 'yandex'].forEach(function (pl) {
    var keys = {};
    var def = defaultTokenKey_(pl);
    keys[def] = first;
    dealers.forEach(function (d) { var k = String(d[pl + '_token_key'] || '').trim(); if (k) keys[k] = d; });
    Object.keys(keys).forEach(function (k) {
      var token = prop_(k);
      if (!token) { lines.push(pl + ' [' + k + ']: ❌ нет в свойствах скрипта'); return; }
      try {
        var r = pl === 'meta'   ? metaSelfCheck_(token)
              : pl === 'tiktok' ? tiktokSelfCheck_(token)
              : yandexSelfCheck_(token, String(keys[k].yandex_client_login || first.yandex_client_login || ''));
        lines.push(pl + ' [' + k + ']: ✅ ' + r);
      } catch (e) { lines.push(pl + ' [' + k + ']: ❌ ' + e.message); }
    });
  });

  var tg = prop_('TELEGRAM_BOT_TOKEN') && prop_('TELEGRAM_CHAT_ID');
  lines.push('Telegram: ' + (tg ? '✅ токен и chat_id заданы (проверка — «Telegram: тестовое сообщение»)'
                                : '❌ не заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID'));

  SpreadsheetApp.getUi().alert('Проверка токенов', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---------------------------------------------------------------------------
function askDealer_() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('dealer_id из Registry (например BYD):');
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  var d = findDealer(r.getResponseText());
  if (!d) { ui.alert('Дилер не найден: ' + r.getResponseText()); return null; }
  return d;
}

function menuRunOneDaily() {
  var d = askDealer_(); if (!d) return;
  runOneAndReport_(d, buildPeriods('daily'));
}

function menuRunOneMonth() {
  var d = askDealer_(); if (!d) return;
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Месяц в формате ГГГГ-ММ (например 2026-08):');
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var m = /^(\d{4})-(\d{1,2})$/.exec(r.getResponseText().trim());
  if (!m) { ui.alert('Неверный формат'); return; }
  runOneAndReport_(d, customPeriod(parseInt(m[1], 10), parseInt(m[2], 10)));
}

function runOneAndReport_(dealer, periods) {
  var ui = SpreadsheetApp.getUi();
  var res = runDealer(dealer, periods);
  var names = periods.map(function (p) { return p.header; }).join(', ');
  var keptText = (res.kept || []).map(function (k) {
    return '• ' + k.platform + ' — ' + k.period + ': не отдал данные (HTTP 204)' + (k.mp ? '\n   В МП: ' + k.mp : '');
  }).join('\n');
  if (!res.errors.length) {
    ui.alert('Готово: ' + dealer.dealer_id + ' — ' + names +
             (keptText ? '\n\nОбновлены все площадки, кроме:\n' + keptText : '') +
             '\n\nПодробности — вкладка Log.');
    return;
  }
  var lines = groupErrors_(dealer, res.errors).map(function (g) {
    return '• ' + g.platform + (g.account ? ' [' + g.account + ']' : '') + ' — ' + g.periods.join(', ') +
           '\n   Причина: ' + g.rule.reason +
           '\n   Как исправить: ' + g.rule.fix +
           (g.mp.length ? '\n   В МП: ' + g.mp.join('; ') : '');
  });
  ui.alert('Выгружено с ошибками: ' + dealer.dealer_id,
    (res.written.length ? 'Записано в МП: ' + res.written.join(', ') + '\n\n' : 'В МП ничего не записано.\n\n') +
    lines.join('\n\n') + (keptText ? '\n\nНе отдали данные (строки в МП оставлены):\n' + keptText : '') +
    '\n\nПодробно — вкладка «' + ERR.SHEET + '».',
    ui.ButtonSet.OK);
}

function menuCreateTargetSheets() {
  var n = 0, err = [];
  activeDealers().forEach(function (d) {
    try { targetSheet_(d, true); n++; } catch (e) { err.push(d.dealer_id + ': ' + e.message); }
  });
  SpreadsheetApp.getUi().alert('Вкладки проверены/созданы: ' + n + (err.length ? '\nОшибки:\n' + err.join('\n') : ''));
}

function menuRunAllDaily()   { startQueue_('daily');   menuShowQueue(); }
function menuRunAllMonthly() { startQueue_('monthly'); menuShowQueue(); }

function menuRunAllCustom() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Какие месяцы выгрузить ВСЕМ дилерам?',
    'Один месяц: 2026-05\nДиапазон: 2026-01..2026-07', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var periods;
  try { periods = parseMonthRange(r.getResponseText()); }
  catch (e) { ui.alert(e.message); return; }
  var n = activeDealers().length;
  var ok = ui.alert('Подтверждение',
    'Дилеров: ' + n + '\nМесяцев: ' + periods.length + ' (' +
    periods.map(function (p) { return p.header.replace('месяц ', ''); }).join(', ') + ')\n\n' +
    'Данные за эти месяцы в МП будут перезаписаны. Запускаем?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  startQueue_('custom', periods);
  menuShowQueue();
}

function menuShowQueue() {
  SpreadsheetApp.getUi().alert('Прогресс', progressText_(), SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuInstallTriggers() { SpreadsheetApp.getUi().alert('Триггеры установлены', installTriggers(), SpreadsheetApp.getUi().ButtonSet.OK); }
function menuRemoveTriggers()  { SpreadsheetApp.getUi().alert('Удалено триггеров: ' + removeTriggers()); }