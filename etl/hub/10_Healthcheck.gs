/**
 * 10_Healthcheck.gs — ПРОВЕРОЧНЫЙ ЛИСТ ДЛЯ AUTOREPORT HUB
 *
 * ЗАЧЕМ:
 *   Проходит по всем дилерам из Registry, открывает таблицу МП, читает вкладку
 *   Ads Data и отвечает на два вопроса:
 *     1) Дошли ли данные за вчера? (дата в колонке A блока текущего месяца)
 *     2) Не пропала ли отдельная площадка? (расход месяц-к-дате не должен падать)
 *
 * ПОЧЕМУ ДВА ВОПРОСА, А НЕ ОДИН:
 *   Если весь запуск упал — устареет дата, это видно сразу.
 *   Если упала ОДНА площадка (Meta вернула 190, TikTok — 40002), скрипт всё равно
 *   перезапишет блок месяца: дата станет вчерашней, но строки этой площадки
 *   исчезнут, а кумулятивный расход за месяц уменьшится. По дате такое не поймать,
 *   поэтому каждый запуск пишет снимок в «Проверка_История» и сравнивается
 *   с предыдущим снимком.
 *
 * КУДА СТАВИТЬ:
 *   Новый файл в проекте Apps Script таблицы «Autoreport Hub». Ничего из
 *   01_Core…09_Tools не трогает, свои вкладки создаёт сам.
 *
 * ЗАПУСК:
 *   healthcheckRun()            — проверить сейчас (меню/вручную)
 *   healthcheckDaily()          — точка входа для триггера
 *   healthcheckInstallTrigger() — поставить ежедневный триггер
 *   healthcheckRemoveTrigger()  — снять
 *   healthcheckDebugRegistry()  — показать в логе, какие колонки Registry распознаны
 */

// ---------------------------------------------------------------------------
// НАСТРОЙКИ
// ---------------------------------------------------------------------------

var HC = {
  DASHBOARD_SHEET: 'Проверка',
  HISTORY_SHEET:   'Проверка_История',
  REGISTRY_SHEET:  'Registry',

  // Как может называться вкладка с данными в таблице МП (проверяются по порядку)
  ADS_DATA_TABS: ['Ads Data', 'Ads Data (hub)', 'AdsData', 'Ads_Data'],

  // Сколько суток отставания считать жёлтым, а не красным.
  // 0 — данные обязаны быть за вчера; 1 — допускаем ещё сутки (напр. если дилера
  // считает отдельный триггер позже).
  ALLOW_LAG_DAYS: 0,

  // Падение расхода месяц-к-дате больше этой суммы (в валюте листа) = проблема.
  // Небольшой допуск нужен: площадки уточняют расход задним числом.
  COST_DROP_TOLERANCE: 1,

  // Определять площадку по названию кампании (суффиксы _meta/_google/_tiktok/_yandex,
  // префиксы «Meta | » и т.п.). Если в МП нейминг без маркеров — выключить,
  // проверка останется на уровне «всего по дилеру».
  PLATFORM_FROM_NAME: true,

  // Кому слать письмо при проблемах. Пусто — владельцу скрипта.
  ALERT_EMAIL: '',
  ALERT_ONLY_PROBLEMS: true,   // true — письмо только если есть ⚠️/❌

  HISTORY_LIMIT: 30000,        // строк в «Проверка_История», старые отрезаются
  TRIGGER_HOUR: 11,            // час ежедневной проверки (ставить ПОСЛЕ выгрузки)
  MAX_RUNTIME_MS: 5 * 60 * 1000
};

// Псевдонимы колонок Registry (регистр, пробелы и подчёркивания не важны)
var HC_COLS = {
  id:     ['dealer_id', 'dealerid', 'id', 'дилер', 'dealer'],
  name:   ['name', 'dealer_name', 'название', 'бренд', 'brand', 'title'],
  target: ['mp_id', 'mp_spreadsheet_id', 'mp_url', 'mp', 'мп', 'медиаплан',
           'target_spreadsheet_id', 'target_id', 'spreadsheet_id', 'sheet_id', 'ссылка'],
  tab:    ['mp_tab', 'target_tab', 'tab', 'вкладка', 'ads_data_tab'],
  active: ['active', 'enabled', 'вкл', 'включен', 'включён', 'статус', 'on']
};

// Правила распознавания площадки по названию кампании
var HC_PLATFORM_RULES = [
  { name: 'Google', re: /(^|[\s|_\-\/])(google|gads|adwords|youtube|pmax|p-max|perfmax|demandgen)([\s|_\-\/]|$)/i },
  { name: 'Meta',   re: /(^|[\s|_\-\/])(meta|facebook|fb|instagram|inst|ig)([\s|_\-\/]|$)/i },
  { name: 'TikTok', re: /(^|[\s|_\-\/])(tiktok|tik-tok|tt)([\s|_\-\/]|$)/i },
  { name: 'Yandex', re: /(^|[\s|_\-\/])(yandex|яндекс|direct|директ|rsya|рся|ydirect|ya)([\s|_\-\/]|$)/i }
];

var HC_UNKNOWN = 'Не определено';
var HC_TOTAL   = 'ИТОГО';

// ---------------------------------------------------------------------------
// ТОЧКИ ВХОДА
// ---------------------------------------------------------------------------

function healthcheckRun() {
  var res = hcRun_();
  var bad = res.filter(function (r) { return r.status !== 'OK'; });
  try {
    SpreadsheetApp.getUi().alert(
      'Проверка завершена',
      'Дилеров проверено: ' + res.length + '\n' +
      'С проблемами: ' + bad.length + '\n\n' +
      (bad.length ? bad.slice(0, 15).map(function (r) {
        return r.status + ' ' + (r.name || r.id) + ' — ' + r.comments.join('; ');
      }).join('\n') : 'Все медиапланы обновлены за вчера.') +
      (bad.length > 15 ? '\n… и ещё ' + (bad.length - 15) + ' — смотри вкладку «' + HC.DASHBOARD_SHEET + '»' : ''),
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* запуск не из UI */ }
  return res;
}

function healthcheckDaily() { hcRun_(); }

function healthcheckInstallTrigger() {
  healthcheckRemoveTrigger_();
  ScriptApp.newTrigger('healthcheckDaily').timeBased().atHour(HC.TRIGGER_HOUR).everyDays(1).create();
  try {
    SpreadsheetApp.getUi().alert('Триггер проверки поставлен на ~' + HC.TRIGGER_HOUR + ':00. ' +
      'Убедись, что это ПОСЛЕ ежедневной выгрузки Hub.');
  } catch (e) {}
}

function healthcheckRemoveTrigger() {
  var n = healthcheckRemoveTrigger_();
  try { SpreadsheetApp.getUi().alert('Удалено триггеров проверки: ' + n); } catch (e) {}
}

function healthcheckRemoveTrigger_() {
  var t = ScriptApp.getProjectTriggers(), n = 0;
  for (var i = 0; i < t.length; i++) {
    if (t[i].getHandlerFunction() === 'healthcheckDaily') { ScriptApp.deleteTrigger(t[i]); n++; }
  }
  return n;
}

/** Показывает, как скрипт понял структуру Registry. Запусти один раз после установки. */
function healthcheckDebugRegistry() {
  var reg = hcReadRegistry_(SpreadsheetApp.getActive());
  Logger.log('Заголовки Registry: ' + reg.headers.join(' | '));
  Logger.log('Распознано: id=%s, name=%s, target=%s, tab=%s, active=%s',
    reg.map.id, reg.map.name, reg.map.target, reg.map.tab, reg.map.active);
  Logger.log('Колонки площадок: ' + JSON.stringify(reg.platformCols));
  Logger.log('Дилеров к проверке: ' + reg.rows.length);
  reg.rows.slice(0, 10).forEach(function (d) {
    Logger.log('  • %s | МП id=%s | ожидаемые площадки: %s',
      d.id, d.targetId || '—', d.expected.join(', ') || '—');
  });
}

// ---------------------------------------------------------------------------
// ЯДРО
// ---------------------------------------------------------------------------

function hcRun_() {
  var t0 = new Date().getTime();
  var ss = SpreadsheetApp.getActive();
  var tz = ss.getSpreadsheetTimeZone() || 'Asia/Almaty';
  var yesterday = hcMidnight_(new Date(new Date().getTime() - 864e5));

  var reg = hcReadRegistry_(ss);
  if (!reg.rows.length) {
    Logger.log('❌ В «' + HC.REGISTRY_SHEET + '» не найдено ни одного дилера с ID таблицы МП. ' +
               'Запусти healthcheckDebugRegistry() и проверь названия колонок.');
    return [];
  }
  Logger.log('🔎 Проверка за ' + Utilities.formatDate(yesterday, tz, 'dd.MM.yyyy') +
             '. Дилеров: ' + reg.rows.length);

  var prev = hcLoadPrevSnapshot_(ss);
  var results = [];

  for (var i = 0; i < reg.rows.length; i++) {
    if (new Date().getTime() - t0 > HC.MAX_RUNTIME_MS) {
      Logger.log('⏱ Лимит времени — проверено ' + i + ' из ' + reg.rows.length);
      break;
    }
    var r = hcCheckDealer_(reg.rows[i], yesterday, prev, tz);
    results.push(r);
    Logger.log('%s %s — %s', r.status, (r.name || r.id), (r.comments.join('; ') || 'ок'));
  }

  hcWriteDashboard_(ss, results, yesterday, tz);
  hcAppendHistory_(ss, results, tz);
  hcSendAlert_(results, yesterday, tz);
  return results;
}

/** Чтение Registry с распознаванием колонок по заголовкам. */
function hcReadRegistry_(ss) {
  var out = { headers: [], map: {}, platformCols: {}, rows: [] };
  var sh = ss.getSheetByName(HC.REGISTRY_SHEET);
  if (!sh) { Logger.log('❌ Вкладка «' + HC.REGISTRY_SHEET + '» не найдена'); return out; }

  var data = sh.getDataRange().getValues();
  if (data.length < 2) return out;

  var headers = data[0].map(function (h) { return String(h || '').trim(); });
  out.headers = headers;
  var norm = headers.map(function (h) { return h.toLowerCase().replace(/[\s\-]+/g, '_'); });

  Object.keys(HC_COLS).forEach(function (key) {
    var idx = -1;
    HC_COLS[key].forEach(function (alias) {
      if (idx > -1) return;
      for (var i = 0; i < norm.length; i++) {
        if (norm[i] === alias) { idx = i; return; }
      }
      for (var j = 0; j < norm.length; j++) {
        if (norm[j].indexOf(alias) > -1) { idx = j; return; }
      }
    });
    out.map[key] = idx;
  });

  // Колонки с идентификаторами кабинетов → из них берём «ожидаемые» площадки
  norm.forEach(function (h, i) {
    var plat = null;
    if (/google|gads|adwords/.test(h)) plat = 'Google';
    else if (/meta|facebook|\bfb\b/.test(h)) plat = 'Meta';
    else if (/tiktok|tik_tok/.test(h)) plat = 'TikTok';
    else if (/yandex|direct|директ|яндекс/.test(h)) plat = 'Yandex';
    if (!plat) return;
    if (!/id|customer|account|act|advertiser|client|login/.test(h)) return;
    (out.platformCols[plat] = out.platformCols[plat] || []).push(i);
  });

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var id = out.map.id > -1 ? String(row[out.map.id] || '').trim() : '';
    var rawTarget = out.map.target > -1 ? String(row[out.map.target] || '').trim() : '';
    if (!id && !rawTarget) continue;

    if (out.map.active > -1) {
      var a = String(row[out.map.active] || '').trim().toLowerCase();
      if (a === 'false' || a === 'нет' || a === 'no' || a === '0' || a === 'off' || a === 'выкл') continue;
    }

    var expected = [];
    Object.keys(out.platformCols).forEach(function (plat) {
      var has = out.platformCols[plat].some(function (c) {
        return String(row[c] || '').trim() !== '';
      });
      if (has) expected.push(plat);
    });

    out.rows.push({
      id: id || rawTarget.substring(0, 20),
      name: out.map.name > -1 ? String(row[out.map.name] || '').trim() : id,
      targetId: hcExtractId_(rawTarget),
      url: rawTarget,
      tab: out.map.tab > -1 ? String(row[out.map.tab] || '').trim() : '',
      expected: expected,
      registryRow: r + 1
    });
  }
  return out;
}

/** Проверка одного дилера. */
function hcCheckDealer_(d, yesterday, prev, tz) {
  var res = {
    id: d.id, name: d.name || d.id, targetId: d.targetId, url: d.url,
    tab: '', month: '', lastDate: null, lagDays: '',
    campaigns: 0, impressions: 0, cost: 0, deltaCost: '',
    platforms: {}, expected: d.expected, unknownShare: 0,
    status: 'OK', comments: []
  };

  if (!d.targetId) {
    res.status = '❌'; res.comments.push('в Registry нет ID таблицы МП (строка ' + d.registryRow + ')');
    return res;
  }

  var ss;
  try { ss = SpreadsheetApp.openById(d.targetId); }
  catch (e) {
    res.status = '❌'; res.comments.push('нет доступа к таблице МП: ' + e.message);
    return res;
  }

  var tabs = d.tab ? [d.tab].concat(HC.ADS_DATA_TABS) : HC.ADS_DATA_TABS;
  var sh = null;
  for (var i = 0; i < tabs.length; i++) {
    sh = ss.getSheetByName(tabs[i]);
    if (sh) { res.tab = tabs[i]; break; }
  }
  if (!sh) {
    res.status = '❌';
    res.comments.push('во вкладках МП нет ни одной из: ' + tabs.join(' / '));
    return res;
  }

  var values;
  try { values = sh.getDataRange().getValues(); }
  catch (e) { res.status = '❌'; res.comments.push('не читается вкладка: ' + e.message); return res; }

  var block = hcLastBlock_(values);
  if (!block || !block.rows.length) {
    res.status = '❌'; res.comments.push('вкладка «' + res.tab + '» пустая — данных нет вообще');
    return res;
  }
  res.month = block.header;

  // --- агрегация блока текущего месяца по площадкам ---
  var unknown = 0;
  block.rows.forEach(function (row) {
    var name = String(row[1] || '').trim();
    if (!name) return;
    var dt = hcToDate_(row[0]);
    var plat = HC.PLATFORM_FROM_NAME ? hcDetectPlatform_(name) : HC_TOTAL;
    if (plat === HC_UNKNOWN) unknown++;

    var p = res.platforms[plat] || (res.platforms[plat] = { campaigns: 0, impressions: 0, cost: 0, lastDate: null });
    p.campaigns++;
    p.impressions += hcNum_(row[2]);
    p.cost += hcNum_(row[6]);
    if (dt && (!p.lastDate || dt > p.lastDate)) p.lastDate = dt;

    res.campaigns++;
    res.impressions += hcNum_(row[2]);
    res.cost += hcNum_(row[6]);
    if (dt && (!res.lastDate || dt > res.lastDate)) res.lastDate = dt;
  });

  res.unknownShare = res.campaigns ? Math.round(100 * unknown / res.campaigns) : 0;

  // --- 1. свежесть даты ---
  if (!res.lastDate) {
    res.status = '❌';
    res.comments.push('в колонке A нет распознаваемых дат');
  } else {
    var lag = Math.round((yesterday.getTime() - res.lastDate.getTime()) / 864e5);
    res.lagDays = lag;
    if (lag > HC.ALLOW_LAG_DAYS) {
      res.status = lag > HC.ALLOW_LAG_DAYS + 2 ? '❌' : '⚠️';
      res.comments.push('данные за ' + hcFmtDate_(res.lastDate, tz) + ', отставание ' + lag + ' дн.');
    } else if (lag < 0) {
      res.comments.push('дата в листе новее вчерашней (' + hcFmtDate_(res.lastDate, tz) + ')');
    }
  }

  // --- 2. сравнение с предыдущим снимком (тот же месяц) ---
  var prevTotal = prev[hcKey_(d.id, HC_TOTAL)];
  if (prevTotal && prevTotal.month === res.month) {
    var delta = res.cost - prevTotal.cost;
    res.deltaCost = delta;
    if (delta < -HC.COST_DROP_TOLERANCE) {
      res.status = '❌';
      res.comments.push('расход за месяц УПАЛ на ' + hcFmtNum_(-delta) +
                        ' (было ' + hcFmtNum_(prevTotal.cost) + ', стало ' + hcFmtNum_(res.cost) + ')');
    }
    if (res.campaigns < prevTotal.campaigns) {
      res.status = res.status === '❌' ? '❌' : '⚠️';
      res.comments.push('кампаний стало меньше: ' + prevTotal.campaigns + ' → ' + res.campaigns);
    }
  }

  // --- 3. по каждой площадке ---
  if (HC.PLATFORM_FROM_NAME) {
    var all = {};
    Object.keys(res.platforms).forEach(function (p) { all[p] = true; });
    d.expected.forEach(function (p) { all[p] = true; });
    Object.keys(prev).forEach(function (k) {
      var parts = k.split('|||');
      if (parts[0] === d.id && parts[1] !== HC_TOTAL && parts[1] !== HC_UNKNOWN) all[parts[1]] = true;
    });

    Object.keys(all).forEach(function (plat) {
      if (plat === HC_UNKNOWN || plat === HC_TOTAL) return;
      var cur = res.platforms[plat];
      var was = prev[hcKey_(d.id, plat)];
      var wasActive = was && was.month === res.month && (was.cost > 0 || was.campaigns > 0);

      if (!cur) {
        if (wasActive) {
          res.status = '❌';
          res.comments.push(plat + ': строки пропали (в прошлой проверке было ' +
                            was.campaigns + ' кампаний на ' + hcFmtNum_(was.cost) + ')');
        } else if (d.expected.indexOf(plat) > -1) {
          res.status = res.status === '❌' ? '❌' : '⚠️';
          res.comments.push(plat + ': кабинет в Registry есть, строк в МП нет');
        }
        return;
      }
      var plag = cur.lastDate ? Math.round((yesterday.getTime() - cur.lastDate.getTime()) / 864e5) : 999;
      if (plag > HC.ALLOW_LAG_DAYS) {
        res.status = '⚠️';
        res.comments.push(plat + ': последняя дата ' +
          (cur.lastDate ? hcFmtDate_(cur.lastDate, tz) : '—') + ' (−' + plag + ' дн.)');
      }
      if (wasActive && cur.cost - was.cost < -HC.COST_DROP_TOLERANCE) {
        res.status = '❌';
        res.comments.push(plat + ': расход упал ' + hcFmtNum_(was.cost) + ' → ' + hcFmtNum_(cur.cost));
      }
    });

    if (res.unknownShare >= 50 && res.campaigns > 0) {
      res.comments.push('⚠ ' + res.unknownShare + '% кампаний без маркера площадки — ' +
                        'проверка по площадкам неполная');
    }
  }

  return res;
}

// ---------------------------------------------------------------------------
// РАЗБОР ЛИСТА Ads Data
// ---------------------------------------------------------------------------

/** Возвращает блок «месяц …» с самой свежей датой (обычно текущий месяц). */
function hcLastBlock_(values) {
  var blocks = [], cur = null;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var a = (row[0] instanceof Date) ? '' : String(row[0] || '').trim();
    if (a.toLowerCase().indexOf('месяц ') === 0) {
      cur = { header: a, rows: [], maxDate: null };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (String(row.join('')).trim() === '') continue;
    cur.rows.push(row);
    var dt = hcToDate_(row[0]);
    if (dt && (!cur.maxDate || dt > cur.maxDate)) cur.maxDate = dt;
  }
  if (!blocks.length) return null;

  var best = null;
  blocks.forEach(function (b) {
    if (!b.rows.length) return;
    if (!best) { best = b; return; }
    if (b.maxDate && (!best.maxDate || b.maxDate > best.maxDate)) best = b;
  });
  return best || blocks[blocks.length - 1];
}

function hcDetectPlatform_(name) {
  for (var i = 0; i < HC_PLATFORM_RULES.length; i++) {
    if (HC_PLATFORM_RULES[i].re.test(name)) return HC_PLATFORM_RULES[i].name;
  }
  return HC_UNKNOWN;
}

// ---------------------------------------------------------------------------
// ВКЛАДКА «Проверка»
// ---------------------------------------------------------------------------

function hcWriteDashboard_(ss, results, yesterday, tz) {
  var sh = ss.getSheetByName(HC.DASHBOARD_SHEET) || ss.insertSheet(HC.DASHBOARD_SHEET);
  sh.clear();

  var plats = ['Google', 'Meta', 'TikTok', 'Yandex'];
  var header = ['Статус', 'Дилер', 'МП', 'Вкладка', 'Месяц', 'Дата в листе', 'Отставание, дн',
                'Кампаний', 'Показы', 'Расход (месяц)', 'Δ расход']
                .concat(plats).concat(['Комментарий']);

  var rows = [], colors = [];
  var bg = { 'OK': '#e6f4ea', '⚠️': '#fff4e5', '❌': '#fce8e6' };

  results.sort(function (a, b) {
    var w = { '❌': 0, '⚠️': 1, 'OK': 2 };
    return (w[a.status] - w[b.status]) || String(a.name).localeCompare(String(b.name));
  });

  results.forEach(function (r) {
    var line = [
      r.status,
      r.name,
      r.targetId ? '=HYPERLINK("https://docs.google.com/spreadsheets/d/' + r.targetId + '";"открыть")' : '—',
      r.tab || '—',
      r.month || '—',
      r.lastDate ? hcFmtDate_(r.lastDate, tz) : '—',
      r.lagDays === '' ? '' : r.lagDays,
      r.campaigns || 0,
      r.impressions || 0,
      Math.round(r.cost || 0),
      r.deltaCost === '' ? '' : Math.round(r.deltaCost)
    ];
    plats.forEach(function (p) {
      var c = r.platforms[p];
      if (c) line.push(c.campaigns + ' камп · ' + hcFmtNum_(c.cost) +
                       (c.lastDate ? ' · ' + hcFmtDate_(c.lastDate, tz).substring(0, 5) : ''));
      else line.push(r.expected.indexOf(p) > -1 ? '✗ нет строк' : '—');
    });
    line.push(r.comments.join('; '));
    rows.push(line);

    var color = bg[r.status] || '#ffffff';
    colors.push(header.map(function () { return color; }));
  });

  var stamp = 'Проверка за ' + hcFmtDate_(yesterday, tz) +
              ' · выполнена ' + Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy HH:mm') +
              ' · дилеров: ' + results.length +
              ' · проблем: ' + results.filter(function (r) { return r.status !== 'OK'; }).length;

  sh.getRange(1, 1).setValue(stamp).setFontWeight('bold').setFontSize(11);
  sh.getRange(3, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#f1f3f4').setWrap(true);

  if (rows.length) {
    sh.getRange(4, 1, rows.length, header.length).setValues(rows);
    sh.getRange(4, 1, rows.length, header.length).setBackgrounds(colors);
    sh.getRange(4, 9, rows.length, 3).setNumberFormat('#,##0');
  }
  sh.setFrozenRows(3);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidth(header.length, 520);
  try { sh.autoResizeColumns(4, 8); } catch (e) {}
}

// ---------------------------------------------------------------------------
// ИСТОРИЯ СНИМКОВ
// ---------------------------------------------------------------------------

function hcAppendHistory_(ss, results, tz) {
  var sh = ss.getSheetByName(HC.HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(HC.HISTORY_SHEET);
    sh.getRange(1, 1, 1, 8).setValues([[
      'Проверено', 'dealer_id', 'Месяц', 'Площадка', 'Последняя дата', 'Кампаний', 'Показы', 'Расход'
    ]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideSheet();
  }

  var now = new Date();
  var out = [];
  results.forEach(function (r) {
    if (!r.month) return;
    out.push([now, r.id, r.month, HC_TOTAL,
              r.lastDate ? hcFmtDate_(r.lastDate, tz) : '', r.campaigns, r.impressions, r.cost]);
    Object.keys(r.platforms).forEach(function (p) {
      if (p === HC_TOTAL) return;
      var c = r.platforms[p];
      out.push([now, r.id, r.month, p,
                c.lastDate ? hcFmtDate_(c.lastDate, tz) : '', c.campaigns, c.impressions, c.cost]);
    });
  });
  if (!out.length) return;

  sh.getRange(sh.getLastRow() + 1, 1, out.length, 8).setValues(out);

  var extra = sh.getLastRow() - 1 - HC.HISTORY_LIMIT;
  if (extra > 0) sh.deleteRows(2, extra);
}

/** Последний снимок по каждому dealer|площадка (до текущего запуска). */
function hcLoadPrevSnapshot_(ss) {
  var map = {};
  var sh = ss.getSheetByName(HC.HISTORY_SHEET);
  if (!sh || sh.getLastRow() < 2) return map;

  var last = sh.getLastRow();
  var start = Math.max(2, last - 4000);            // хватает на несколько последних прогонов
  var data = sh.getRange(start, 1, last - start + 1, 8).getValues();

  data.forEach(function (row) {
    var id = String(row[1] || '').trim();
    var plat = String(row[3] || '').trim();
    if (!id || !plat) return;
    map[hcKey_(id, plat)] = {
      ts: row[0],
      month: String(row[2] || '').trim(),
      lastDate: row[4],
      campaigns: hcNum_(row[5]),
      impressions: hcNum_(row[6]),
      cost: hcNum_(row[7])
    };
  });
  return map;
}

// ---------------------------------------------------------------------------
// ПИСЬМО
// ---------------------------------------------------------------------------

function hcSendAlert_(results, yesterday, tz) {
  var bad = results.filter(function (r) { return r.status !== 'OK'; });
  if (HC.ALERT_ONLY_PROBLEMS && !bad.length) return;

  var to = HC.ALERT_EMAIL || Session.getEffectiveUser().getEmail();
  if (!to) return;

  var lines = bad.map(function (r) {
    return r.status + ' ' + r.name +
      '\n   ' + r.comments.join('\n   ') +
      (r.targetId ? '\n   https://docs.google.com/spreadsheets/d/' + r.targetId : '');
  });

  var subject = bad.length
    ? '⚠️ Autoreport: не обновились ' + bad.length + ' из ' + results.length + ' МП за ' + hcFmtDate_(yesterday, tz)
    : '✅ Autoreport: все ' + results.length + ' МП обновлены за ' + hcFmtDate_(yesterday, tz);

  var body = 'Проверка данных за ' + hcFmtDate_(yesterday, tz) + '\n' +
             'Проверено дилеров: ' + results.length + ', с проблемами: ' + bad.length + '\n\n' +
             (lines.join('\n\n') || 'Проблем нет.') +
             '\n\nПодробности — вкладка «' + HC.DASHBOARD_SHEET + '» в Autoreport Hub:\n' +
             SpreadsheetApp.getActive().getUrl();

  try { MailApp.sendEmail(to, subject, body); }
  catch (e) { Logger.log('❌ Письмо не отправлено: ' + e.message); }
}

// ---------------------------------------------------------------------------
// УТИЛИТЫ
// ---------------------------------------------------------------------------

function hcKey_(id, plat) { return id + '|||' + plat; }

function hcMidnight_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function hcToDate_(v) {
  if (v instanceof Date) return hcMidnight_(v);
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return null;
}

function hcFmtDate_(d, tz) {
  return d ? Utilities.formatDate(d, tz || 'Asia/Almaty', 'dd.MM.yyyy') : '—';
}

function hcNum_(v) {
  if (typeof v === 'number') return v;
  var s = String(v == null ? '' : v).replace(/\s|\u00A0/g, '').replace(',', '.');
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function hcFmtNum_(n) {
  return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function hcExtractId_(s) {
  var str = String(s || '').trim();
  if (!str) return '';
  var m = str.match(/\/d\/([a-zA-Z0-9\-_]{25,})/);
  if (m) return m[1];
  m = str.match(/^[a-zA-Z0-9\-_]{25,}$/);
  return m ? str : '';
}