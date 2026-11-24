/**
 * 06_Pipeline.gs — обработка одного дилера и запись в целевую таблицу (МП).
 *
 * runDealer(dealer, periods):
 *   для каждого периода → Google + Meta + TikTok + Yandex → корректировка имён →
 *   агрегация → запись блока "месяц Х" в mp_spreadsheet_id / mp_sheet_name.
 *
 * ИЗМЕНЕНО (ошибки площадок):
 *   E1. Упала площадка — она ПРОПУСКАЕТСЯ, остальные площадки выгружаются и пишутся в МП.
 *       Раньше при ошибке хотя бы одной площадки период не записывался вообще.
 *   E2. Чтобы строки упавшей площадки не исчезли из МП, из текущего блока МП берутся
 *       строки, которых нет среди свежих данных успешных площадок, и остаются в блоке
 *       как были (со своей прежней датой — «Проверка» увидит, что они не обновились).
 *   E3. Упали ВСЕ настроенные площадки дилера — период в МП не трогается.
 *   E4. Ошибки → «Журнал ошибок» (причина + как исправить), строка дилера в Registry —
 *       бледно-красная, сообщение в Telegram. Без ошибок подсветка снимается.
 *   E5. runDealer больше не бросает исключение, а возвращает { dealer_id, errors, written, kept }.
 *       Ошибка записи в МП (нет доступа, удалена таблица) тоже ловится и журналируется.
 *   E6. «Мягкий» отказ площадки (сейчас — Яндекс HTTP 204 при YANDEX_204_MODE = KEEP):
 *       строки площадки остаются в МП с прошлой выгрузки, как при ошибке, но это НЕ ошибка —
 *       нет записи в журнале, нет красной строки и Telegram. В Registry статус
 *       "OK · Yandex: …, оставлены прошлые данные", в Log — "НЕТ ДАННЫХ".
 */

var PIPELINE_PLATFORMS = ['Google', 'Meta', 'TikTok', 'Yandex'];
var WRITE_PLATFORM = 'Запись в МП';

function platformFetcher_(name) {
  if (name === 'Google') return fetchGoogle;
  if (name === 'Meta')   return fetchMeta;
  if (name === 'TikTok') return fetchTikTok;
  if (name === 'Yandex') return fetchYandex;
  return null;
}

function errMsg_(e) {
  return String(e && e.message ? e.message : e);
}

function runDealer(dealer, periods) {
  var errors = [];    // {platform, period, message, mp}
  var written = [];   // заголовки записанных блоков
  var kept = [];      // мягкие отказы: {platform, period, message, mp}
  try {
    runDealerCore_(dealer, periods, errors, written, kept);
  } catch (e) {
    errors.push({ platform: 'Скрипт', period: periods.map(function (p) { return p.header; }).join(', '),
                  message: errMsg_(e), mp: 'не записано' });
    logRow(dealer.dealer_id, '', 'Скрипт', 0, 0, 'ERROR ' + errMsg_(e));
  }
  finishDealer_(dealer, errors, kept);
  return { dealer_id: dealer.dealer_id, errors: errors, written: written, kept: kept };
}

function runDealerCore_(dealer, periods, errors, written, softs) {
  var mapping  = readMapping();
  var prefix   = configBool('ADD_PLATFORM_PREFIX');
  var blocks   = [];
  var existing = null;   // блоки МП — читаются, только если какая-то площадка упала

  periods.forEach(function (p) {
    var rows = [], okCount = 0, failed = [];

    PIPELINE_PLATFORMS.forEach(function (name) {
      try {
        var r = platformFetcher_(name)(dealer, p.dFrom, p.dTo, p.disp);
        if (r === null) return;                            // площадка не настроена у дилера
        okCount++;
        if (prefix) r = r.map(function (x) { var c = x.slice(); c[1] = name + ' | ' + c[1]; return c; });
        rows = rows.concat(r);
        logRow(dealer.dealer_id, p.header, name, r.length, sumCost_(r), 'OK');
      } catch (e) {
        failed.push(name);
        if (e && e.keepOldData) {                          // E6: мягкий отказ
          softs.push({ platform: name, period: p.header, message: errMsg_(e), mp: '' });
          logRow(dealer.dealer_id, p.header, name, 0, 0, 'НЕТ ДАННЫХ ' + errMsg_(e) + ' → строки в МП не трогаем');
        } else {
          errors.push({ platform: name, period: p.header, message: errMsg_(e), mp: '' });
          logRow(dealer.dealer_id, p.header, name, 0, 0, 'ERROR ' + errMsg_(e));
        }
      }
    });

    // E3: всё упало — период не трогаем
    if (failed.length && okCount === 0) {
      markMp_(errors, p.header, 'период не перезаписан — в МП прежние данные');
      markMp_(softs, p.header, 'период не перезаписан — в МП прежние данные');
      logRow(dealer.dealer_id, p.header, 'ЗАПИСЬ', 0, '', 'ПРОПУЩЕНО: все площадки дилера с ошибкой');
      return;
    }

    var newRows = aggregateRows_(rows, mapping);

    // E2: сохраняем строки упавших площадок из текущего блока МП
    if (failed.length) {
      if (existing === null) existing = readExistingBlocks_(dealer);
      var kept = keepRowsOfFailed_(existing[p.header] || [], newRows, mapping);
      newRows = newRows.concat(kept);
      var keptNote = kept.length
        ? 'строки ' + failed.join(', ') + ' оставлены с прошлой выгрузки (' + kept.length + ' шт.)'
        : 'в МП не было строк ' + failed.join(', ') + ' за этот месяц — сохранять нечего';
      markMp_(errors, p.header, keptNote);
      markMp_(softs, p.header, keptNote);
      logRow(dealer.dealer_id, p.header, failed.join('+') + ' (из МП)', kept.length, sumCost_(kept),
             'оставлены строки прошлой выгрузки');
    }

    blocks.push({ header: p.header, rows: newRows });
  });

  if (!blocks.length) return;

  try {
    writeBlocks(dealer, blocks);
    blocks.forEach(function (b) { written.push(b.header); });
    logRow(dealer.dealer_id, written.join(', '), 'ЗАПИСЬ',
           blocks.reduce(function (n, b) { return n + b.rows.length; }, 0), '', 'OK');
  } catch (e) {
    var hdr = blocks.map(function (b) { return b.header; }).join(', ');
    errors.push({ platform: WRITE_PLATFORM, period: hdr, message: errMsg_(e), mp: 'ничего не записано' });
    errors.forEach(function (er) { if (er.platform !== WRITE_PLATFORM) er.mp = 'ничего не записано (ошибка записи в МП)'; });
    softs.forEach(function (er) { er.mp = 'ничего не записано (ошибка записи в МП)'; });
    logRow(dealer.dealer_id, hdr, 'ЗАПИСЬ', 0, '', 'ERROR ' + errMsg_(e));
  }
}

function markMp_(errors, header, text) {
  errors.forEach(function (er) { if (er.period === header && !er.mp) er.mp = text; });
}

/** Статус в Registry, подсветка, журнал, Telegram. */
function finishDealer_(dealer, errors, softs) {
  var softNote = softNote_(softs || []);
  if (errors.length) {
    var st = 'ERROR ' + errors.map(function (e) { return e.platform + ': ' + e.message; }).join(' | ') +
             (softNote ? ' | ' + softNote : '');
    setRegistryStatus(dealer, st, true);
    try { reportDealerErrors_(dealer, errors); }
    catch (e) { Logger.log('Журнал ошибок / Telegram: ' + errMsg_(e)); }
  } else {
    setRegistryStatus(dealer, softNote ? 'OK · ' + softNote : 'OK', false);
    try { reportDealerRecovered_(dealer, softNote); }
    catch (e) { Logger.log('Telegram (восстановление): ' + errMsg_(e)); }
  }
}

/** "Yandex: Директ не отдал данные (HTTP 204), оставлены прошлые данные" */
function softNote_(softs) {
  var plats = [];
  softs.forEach(function (s) { if (plats.indexOf(s.platform) === -1) plats.push(s.platform); });
  if (!plats.length) return '';
  return plats.join(', ') + ': площадка не отдала данные (HTTP 204), в МП оставлены прошлые данные';
}

function sumCost_(rows) {
  return Math.round(rows.reduce(function (s, r) { return s + (parseFloat(r[6]) || 0); }, 0) * 100) / 100;
}

/** Корректировка имён по Mapping + слияние одинаковых имён (например с двух Meta-кабинетов). */
function aggregateRows_(rows, mapping) {
  var agg = {}, order = [];
  rows.forEach(function (row) {
    if (!row || row.length < 7 || row[0] === '') return;
    var camp = mapCampaignName(row[1], mapping);
    var key = row[0] + '|||' + normName(camp);
    if (!agg[key]) { agg[key] = { date: row[0], camp: camp, impr: 0, reach: 0, clicks: 0, conv: 0, cost: 0 }; order.push(key); }
    agg[key].impr   += parseInt(row[2])   || 0;
    agg[key].reach  += parseInt(row[3])   || 0;
    agg[key].clicks += parseInt(row[4])   || 0;
    agg[key].conv   += parseFloat(row[5]) || 0;   // дробные конверсии не обрезаем
    agg[key].cost   += parseFloat(row[6]) || 0;
  });
  return order.map(function (k) {
    var o = agg[k];
    return [o.date, o.camp, o.impr, o.reach, o.clicks, Math.round(o.conv * 100) / 100, Math.round(o.cost * 100) / 100];
  });
}

// ---------------------------------------------------------------------------
// СОХРАНЕНИЕ СТРОК УПАВШЕЙ ПЛОЩАДКИ
// ---------------------------------------------------------------------------

/** {"месяц Октябрь": [строки], ...} из текущей вкладки МП. Ошибку не бросает. */
function readExistingBlocks_(dealer) {
  var map = {};
  try {
    var sh = targetSheet_(dealer, false);
    var data = sh.getLastRow() ? sh.getDataRange().getValues() : [];
    parseTargetBlocks_(data).blocks.forEach(function (b) {
      map[b.header] = (map[b.header] || []).concat(b.rows);
    });
  } catch (e) {
    Logger.log('[' + dealer.dealer_id + '] не смог прочитать МП для сохранения строк: ' + errMsg_(e));
  }
  return map;
}

/**
 * Строки старого блока, которых нет среди свежих строк успешных площадок.
 * Это и есть строки упавшей площадки — они остаются в МП как были.
 * Сравнение по имени кампании после Mapping, без учёта регистра и пробелов.
 */
function keepRowsOfFailed_(oldRows, newRows, mapping) {
  var have = {};
  newRows.forEach(function (r) { have[normName(r[1])] = true; });
  var out = [];
  oldRows.forEach(function (r) {
    var name = String(r[1] == null ? '' : r[1]).trim();
    if (!name) return;
    if (have[normName(name)] || have[normName(mapCampaignName(name, mapping))]) return;
    out.push(r.slice(0, 7));
  });
  return out;
}

// ---------------------------------------------------------------------------
// WRITER: заменяет блоки "месяц Х" в целевом листе, остальные блоки не трогает
// ---------------------------------------------------------------------------
function targetSheet_(dealer, createIfMissing) {
  var ssId = String(dealer.mp_spreadsheet_id || '').trim();
  if (!ssId) throw new Error('У дилера ' + dealer.dealer_id + ' не указан mp_spreadsheet_id');
  var ss = SpreadsheetApp.openById(ssId);
  var name = String(dealer.mp_sheet_name || '').trim() || HUB.DEFAULT_TARGET_SHEET;
  var sh = ss.getSheetByName(name);
  if (!sh) {
    if (!createIfMissing) throw new Error('В таблице ' + ssId + ' нет вкладки ' + name);
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, 7).setValues([HUB.HEADER_ROW]).setFontWeight('bold');
  }
  return sh;
}

/** Разбор листа на «шапку» (до первого "месяц") и блоки по месяцам. */
function parseTargetBlocks_(data) {
  var top = [], blocks = [], cur = null;
  data.forEach(function (row) {
    var a = (row[0] instanceof Date) ? '' : String(row[0] == null ? '' : row[0]).trim();
    if (a.toLowerCase().indexOf('месяц ') === 0) {
      if (cur) blocks.push(cur);
      var m = a.split(' ')[1] || '';
      cur = { header: m ? 'месяц ' + m.charAt(0).toUpperCase() + m.slice(1).toLowerCase() : a, rows: [] };
    } else if (!cur) {
      top.push(row);
    } else if (row.join('').trim() !== '') {
      cur.rows.push(row);
    }
  });
  if (cur) blocks.push(cur);
  return { top: top, blocks: blocks };
}

function writeBlocks(dealer, newBlocks) {
  var sh = targetSheet_(dealer, true);
  var data = sh.getLastRow() ? sh.getDataRange().getValues() : [];

  // 1. Разбираем лист на «шапку» и блоки
  var parsed = parseTargetBlocks_(data);
  var top = parsed.top, blocks = parsed.blocks;
  if (!top.length) top = [HUB.HEADER_ROW];

  // 2. Подменяем блоки, которые пришли сейчас; новые добавляем; сортируем по месяцам
  var byHeader = {};
  newBlocks.forEach(function (b) { byHeader[b.header] = b; });
  var merged = [], used = {};
  blocks.forEach(function (b) {
    merged.push(byHeader[b.header] ? byHeader[b.header] : b);
    used[b.header] = true;
  });
  newBlocks.forEach(function (b) { if (!used[b.header]) merged.push(b); });
  var monthIdx = function (h) { var i = HUB.MONTHS.indexOf(String(h).replace(/^месяц\s+/i, '')); return i < 0 ? 99 : i; };
  merged.sort(function (a, b) { return monthIdx(a.header) - monthIdx(b.header); });
  var final = top.slice();
  merged.forEach(function (b) { appendBlock_(final, b); });

  // 3. Пишем
  var safe = final.map(function (r) {
    var out = []; for (var c = 0; c < 7; c++) out.push(r[c] !== undefined && r[c] !== null ? r[c] : '');
    return out;
  });
  sh.clearContents();
  sh.getRange(1, 1, safe.length, 7).setValues(safe);
}

function appendBlock_(table, block) {
  if (table.length > 1) { table.push(['', '', '', '', '', '', '']); table.push(['', '', '', '', '', '', '']); }
  table.push([block.header, '', '', '', '', '', '']);
  block.rows.forEach(function (r) { table.push(r); });
}