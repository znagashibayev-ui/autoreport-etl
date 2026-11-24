/**
 * 07_Queue.gs — очередь дилеров, триггеры, индикатор прогресса.
 *
 * Режимы очереди:
 *   daily   — текущий месяц (+ прошлый до PREV_MONTH_UNTIL_DAY числа)
 *   monthly — прошлый месяц целиком
 *   custom  — любые месяцы, заданные вручную: "2026-01..2026-07" или "2026-05"
 *
 * Apps Script даёт 6 минут на запуск, поэтому hubProcessQueue() работает 4,5 минуты,
 * а если очередь не пуста — ставит триггер «через 1 минуту» и продолжает сама.
 *
 * Прогресс пишется во вкладку «Статус» после каждого дилера.
 */

var P_ = function () { return PropertiesService.getScriptProperties(); };
var PROGRESS_SHEET = 'Статус';
var K_PERIODS = 'HUB_QUEUE_PERIODS', K_TOTAL = 'HUB_QUEUE_TOTAL', K_DONE = 'HUB_QUEUE_DONE', K_START = 'HUB_QUEUE_START';

/** Ежедневно: текущий месяц (+ прошлый до PREV_MONTH_UNTIL_DAY числа). */
function hubDailyStart() { startQueue_('daily'); }

/** MONTHLY_DAY числа: прошлый месяц целиком. */
function hubMonthlyStart() {
  var day = parseInt(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'd'), 10);
  if (day !== configNum('MONTHLY_DAY')) return;
  startQueue_('monthly');
}

/** "2026-01..2026-07" → 7 периодов; "2026-05" → 1 период. */
function parseMonthRange(text) {
  var s = String(text || '').trim();
  var m = /^(\d{4})-(\d{1,2})(?:\s*\.\.\s*(\d{4})-(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error('Формат: ГГГГ-ММ или ГГГГ-ММ..ГГГГ-ММ (например 2026-01..2026-07)');
  var y1 = +m[1], m1 = +m[2], y2 = m[3] ? +m[3] : y1, m2 = m[4] ? +m[4] : m1;
  if (m1 < 1 || m1 > 12 || m2 < 1 || m2 > 12) throw new Error('Месяц должен быть от 1 до 12');
  var periods = [];
  for (var y = y1, mo = m1; (y < y2) || (y === y2 && mo <= m2); ) {
    periods.push(periodForMonth_(y, mo - 1));
    mo++; if (mo > 12) { mo = 1; y++; }
    if (periods.length > 24) throw new Error('Слишком много месяцев за один раз (макс. 24)');
  }
  return periods;
}

function startQueue_(mode, customPeriods) {
  var ids = activeDealers().map(function (d) { return d.dealer_id; });
  if (!ids.length) { Logger.log('Нет активных дилеров'); return; }
  var p = P_();
  p.setProperty(HUB.QUEUE_KEY, JSON.stringify(ids));
  p.setProperty(HUB.QUEUE_MODE_KEY, mode);
  p.setProperty(K_TOTAL, String(ids.length));
  p.setProperty(K_DONE, '0');
  p.setProperty(K_START, String(Date.now()));
  if (mode === 'custom') p.setProperty(K_PERIODS, JSON.stringify(customPeriods || []));
  else p.deleteProperty(K_PERIODS);
  Logger.log('Очередь (' + mode + '): ' + ids.length + ' дилеров');
  updateProgress_('старт', ids.length);
  hubProcessQueue();
}

function queuePeriods_() {
  var mode = P_().getProperty(HUB.QUEUE_MODE_KEY) || 'daily';
  if (mode === 'custom') return JSON.parse(P_().getProperty(K_PERIODS) || '[]');
  return buildPeriods(mode);
}

function hubProcessQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('Уже идёт другой запуск — выхожу'); return; }
  try {
    clearContinuationTriggers_();
    var start = Date.now();
    var queue = JSON.parse(P_().getProperty(HUB.QUEUE_KEY) || '[]');
    var periods = queuePeriods_();
    if (!periods.length) { Logger.log('Нет периодов для обработки'); P_().deleteProperty(HUB.QUEUE_KEY); return; }

    while (queue.length && (Date.now() - start) < HUB.MAX_RUN_MS) {
      var id = queue[0];
      updateProgress_(id, queue.length);
      var dealer = findDealer(id);
      if (dealer) {
        try { runDealer(dealer, periods); }
        catch (e) { Logger.log('[' + id + '] ошибка: ' + e.message); }   // уже записано в Log/Registry
      } else {
        logRow(id, '', 'ALL', 0, 0, 'ERROR дилер не найден в Registry');
      }
      queue.shift();
      P_().setProperty(HUB.QUEUE_KEY, JSON.stringify(queue));
      P_().setProperty(K_DONE, String((parseInt(P_().getProperty(K_DONE), 10) || 0) + 1));
    }

    if (queue.length) {
      ScriptApp.newTrigger('hubProcessQueue').timeBased().after(60 * 1000).create();
      updateProgress_('пауза 1 мин, продолжу автоматически', queue.length);
      Logger.log('Осталось в очереди: ' + queue.length);
    } else {
      P_().deleteProperty(HUB.QUEUE_KEY);
      updateProgress_('✅ завершено', 0);
      Logger.log('Очередь завершена');
    }
  } finally {
    lock.releaseLock();
  }
}

function clearContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hubProcessQueue') ScriptApp.deleteTrigger(t);
  });
}

// ---------------------------------------------------------------------------
// ПРОГРЕСС — вкладка «Статус»
// ---------------------------------------------------------------------------
function updateProgress_(current, remaining) {
  try {
    var p = P_();
    var total = parseInt(p.getProperty(K_TOTAL), 10) || 0;
    var done  = parseInt(p.getProperty(K_DONE), 10) || 0;
    var startTs = parseInt(p.getProperty(K_START), 10) || Date.now();
    var elapsedMin = (Date.now() - startTs) / 60000;
    var perDealer = done > 0 ? elapsedMin / done : 0;
    var etaMin = done > 0 ? perDealer * remaining : 0;
    var pct = total > 0 ? Math.round(done / total * 100) : 0;
    var mode = p.getProperty(HUB.QUEUE_MODE_KEY) || '';
    var modeText = mode === 'custom'
      ? 'выбранные месяцы: ' + JSON.parse(p.getProperty(K_PERIODS) || '[]').map(function (x) { return x.header.replace('месяц ', ''); }).join(', ')
      : mode === 'monthly' ? 'прошлый месяц' : 'текущий месяц';

    var bar = '';
    for (var i = 0; i < 20; i++) bar += (i < Math.round(pct / 5)) ? '█' : '░';

    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(PROGRESS_SHEET) || ss.insertSheet(PROGRESS_SHEET, 0);
    var rows = [
      ['Прогресс',               bar + '  ' + pct + '%'],
      ['Режим',                  modeText],
      ['Всего дилеров',          total],
      ['Готово',                 done],
      ['Осталось',               remaining],
      ['Сейчас',                 current],
      ['Начало',                 new Date(startTs)],
      ['Прошло, мин',            Math.round(elapsedMin * 10) / 10],
      ['Среднее на дилера, мин', Math.round(perDealer * 10) / 10],
      ['Осталось примерно, мин', Math.round(etaMin)],
      ['Ожидаемое окончание',    remaining > 0 && done > 0 ? new Date(Date.now() + etaMin * 60000) : ''],
      ['Обновлено',              new Date()]
    ];
    sh.clearContents();
    sh.getRange(1, 1, rows.length, 2).setValues(rows);
    sh.getRange(1, 1, rows.length, 1).setFontWeight('bold');
    sh.getRange(1, 2).setFontFamily('Courier New').setFontSize(12);
    sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 420);
    SpreadsheetApp.flush();
  } catch (e) { Logger.log('Прогресс не записан: ' + e.message); }
}

function progressText_() {
  var p = P_();
  var q = JSON.parse(p.getProperty(HUB.QUEUE_KEY) || '[]');
  var total = parseInt(p.getProperty(K_TOTAL), 10) || 0;
  var done  = parseInt(p.getProperty(K_DONE), 10) || 0;
  if (!q.length) return 'Очередь пуста — последний прогон завершён (' + done + ' из ' + total + '). Смотри вкладки «Статус» и Log.';
  var startTs = parseInt(p.getProperty(K_START), 10) || Date.now();
  var elapsed = (Date.now() - startTs) / 60000;
  var eta = done > 0 ? elapsed / done * q.length : 0;
  return 'Готово ' + done + ' из ' + total + ' (' + Math.round(done / total * 100) + '%).\n' +
         'Прошло ' + Math.round(elapsed) + ' мин, осталось примерно ' + Math.round(eta) + ' мин.\n' +
         'В очереди: ' + q.slice(0, 10).join(', ') + (q.length > 10 ? ' … (+' + (q.length - 10) + ')' : '') +
         '\n\nПрогресс обновляется во вкладке «Статус». Очередь продолжается сама, окно можно закрыть.';
}

// ---------------------------------------------------------------------------
// УСТАНОВКА ТРИГГЕРОВ
// ---------------------------------------------------------------------------
function installTriggers() {
  removeTriggers();
  var dh = configNum('DAILY_HOUR'), md = configNum('MONTHLY_DAY'), mh = configNum('MONTHLY_HOUR');
  ScriptApp.newTrigger('hubDailyStart').timeBased().atHour(dh).everyDays(1).create();
  ScriptApp.newTrigger('hubMonthlyStart').timeBased().onMonthDay(md).atHour(mh).create();
  return 'Ежедневно ~' + dh + ':00 (текущий месяц), ' + md + '-го числа ~' + mh + ':00 (прошлый месяц). Пояс: ' + Session.getScriptTimeZone();
}

function removeTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'hubDailyStart' || f === 'hubMonthlyStart' || f === 'hubProcessQueue') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}