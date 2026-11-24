/**
 * 11_CampaignMerge.gs — СКЛЕЙКА ДУБЛЕЙ КАМПАНИЙ В ADS DATA  (v2 — строгие правила)
 * Площадки: Meta Ads, TikTok Ads, Google Ads, Яндекс.Директ.
 *
 * Новый файл проекта Autoreport Hub. Ни от одного из файлов 01–10 не зависит.
 *
 * СКЛЕИВАЕМ ТОЛЬКО ЕСЛИ имена отличаются ИСКЛЮЧИТЕЛЬНО:
 *   • регистром                     meta_perf_BMW_X7       = meta_perf_bmw_x7
 *   • пробелами                     meta_perf_BMW_X7       = meta_perf_BMW_X7␣  = meta perf BMW X7
 *   • нижним подчёркиванием         meta_perf_BMW_X7       = meta__perf_BMW_X7  = metaperf_BMW_X7
 *   • дефисом вместо «_»            meta_perf_BMW_X5-X6-X7 = meta_perf_bmw_X5_X6_X7
 *     (как в твоём примере; выключается: CAMPAIGN_MERGE.hyphenEqualsUnderscore = false)
 *   • хвостом _v1, _v2, _v3 …       meta_perf_BMW_X7_v1    = meta_perf_BMW_X7  (также « v2», «-v3», «_V4»)
 *
 * ВО ВСЕХ ОСТАЛЬНЫХ СЛУЧАЯХ НЕ СКЛЕИВАЕМ. В том числе:
 *   …_santa_fe ≠ …_sonata ≠ …_mufasa      (разные модели, даже если имя почти одинаковое)
 *   …_X3 ≠ …_X7,  …_trade-in ≠ …_trade-in_kasko,  …_copy, - Копия, (2), #3, _new — НЕ склеиваются
 *   «похожих» имён и опечаток больше не ищем вообще.
 *
 * ЧЕГО НЕ ДЕЛАЕТ НИКОГДА:
 *   • не склеивает кампании разных площадок (google_… ≠ meta_… ≠ yandex_… ≠ tiktok_…);
 *   • не склеивает строки из разных блоков «месяц …»;
 *   • не трогает колонки правее G и строки до первого блока «месяц …»;
 *   • не теряет деньги: показы/охват/клики/конверсии/расход СУММИРУЮТСЯ.
 *
 * ИМЯ СКЛЕЕННОЙ СТРОКИ: имя без _vN; среди таких — с наибольшим расходом.
 * ДАТА СКЛЕЕННОЙ СТРОКИ: самая свежая из склеенных.
 *
 * ЗАПУСК (из редактора, функция в выпадающем списке):
 *   previewDuplicatesTestMp()  — предпросмотр на одной МП из TEST_MP, ничего не пишет
 *   mergeDuplicatesTestMp()    — склейка на одной МП из TEST_MP
 *   previewDuplicatesAllMp()   — предпросмотр по всем МП из Registry, ничего не пишет
 *   mergeDuplicatesAllMp()     — склейка по всем МП из Registry
 *   installCampaignMergeTrigger() / removeCampaignMergeTrigger() — ежедневный автозапуск
 * Результат каждого запуска — во вкладке «Склейка дублей» этой таблицы (Hub) и в журнале.
 *
 * ВСТРАИВАНИЕ В ВЫГРУЗКУ HUB:
 *   перед записью блока месяца в Ads Data:   rows   = mergeCampaignRows(rows);
 *   или перед записью всего листа A:G:       values = mergeAdsDataValues(values).values;
 */

var CAMPAIGN_MERGE = {
  // --- где искать ---
  ADS_SHEET: 'Ads Data',
  REGISTRY_SHEET: 'Registry',
  REGISTRY_ID_HEADER: '',        // заголовок колонки Registry с URL/ID МП; '' = найти автоматически
  REGISTRY_NAME_HEADER: 'dealer_id',
  REPORT_SHEET: 'Склейка дублей',

  // МП для теста (ссылка или ID). Взято со скриншота «MP | BMW - Bavaria Almaty» — сверь с адресной строкой.
  TEST_MP: 'https://docs.google.com/spreadsheets/d/1R5pBv5_wnD5XXCrorVWGqKXXeaRFlpKU7ZHvLyORzQ8/edit',

  // --- правила склейки ---
  hyphenEqualsUnderscore: true,  // true: «X5-X6-X7» = «X5_X6_X7»; false: дефис — значимый символ
  datePolicy: 'sum',             // 'sum' — суммировать все склеенные строки;
                                 // 'latest' — при разных датах брать только строки с самой свежей датой

  triggerHour: 10,               // час ежедневного автозапуска (часовой пояс проекта)
  maxRunMs: 5 * 60 * 1000        // запас до лимита Apps Script в 6 минут
};

// ===========================================================================
// КЛЮЧ СРАВНЕНИЯ
// ===========================================================================

var CM_PLATFORMS = {
  meta: 'meta', fb: 'meta', facebook: 'meta', ig: 'meta', insta: 'meta', instagram: 'meta', amdg: 'meta',
  google: 'google', gads: 'google', ggl: 'google', youtube: 'google', yt: 'google',
  yandex: 'yandex', ya: 'yandex', yd: 'yandex', direct: 'yandex', 'яндекс': 'yandex',
  tiktok: 'tiktok', tt: 'tiktok', 'тикток': 'tiktok'
};

function cmSepRe_() {
  return CAMPAIGN_MERGE.hyphenEqualsUnderscore ? /[\s_\-]+/g : /[\s_]+/g;
}

/** Срезает хвосты версии: «_v1», « v2», «-v3», «_V4», в т.ч. несколько подряд («_v1_v2»). */
function cmStripVersion_(s) {
  var re = CAMPAIGN_MERGE.hyphenEqualsUnderscore ? /[\s_\-]+v\d+$/i : /[\s_]+v\d+$/i;
  var prev, cut = false;
  do {
    prev = s;
    s = s.replace(re, '');
    if (s !== prev) cut = true;
  } while (s !== prev && s !== '');
  return { name: s === '' ? prev : s, cut: cut };
}

/**
 * key      — имя без регистра, пробелов, «_» (и «-»), без хвоста _vN
 * platform — площадка по первому слову имени ('' если не распознана)
 * hadVer   — в имени был хвост _vN
 */
function cmKeyInfo_(name) {
  var raw = String(name == null ? '' : name).trim();
  var v = cmStripVersion_(raw);
  var key = v.name.toLowerCase().replace(cmSepRe_(), '');
  var first = raw.toLowerCase().split(cmSepRe_())[0] || '';
  return { key: key, platform: CM_PLATFORMS[first] || '', hadVer: v.cut };
}

/** Публичный помощник: ключ, по которому две кампании считаются одной. */
function campaignMergeKey(name) {
  return cmKeyInfo_(name).key;
}

// ===========================================================================
// ЧИСЛА И ДАТЫ
// ===========================================================================

function cmNum_(v) {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  if (v === null || v === undefined || v === '') return 0;
  var s = String(v).replace(/\s/g, '').replace(/\u00a0/g, '').replace(',', '.');
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Убираем «хвосты» плавающей точки (287.68 + 439.51 = 727.1899999…), точность 6 знаков. */
function cmClean_(x) {
  return Math.round(x * 1e6) / 1e6;
}

function cmTime_(v) {
  if (v instanceof Date) return v.getTime();
  var m = String(v == null ? '' : v).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
  return 0;
}

function cmDateText_(v) {
  if (v instanceof Date) {
    var d = v.getDate(), mo = v.getMonth() + 1;
    return (d < 10 ? '0' : '') + d + '.' + (mo < 10 ? '0' : '') + mo + '.' + v.getFullYear();
  }
  return String(v == null ? '' : v);
}

// ===========================================================================
// ЯДРО: склейка строк одного блока «месяц …»
// rows — массив строк [дата, кампания, показы, охват, клики, конверсии, расход]
// opts.merges     — массив, куда сложить описание склеек (для отчёта), необязательно
// opts.label      — подпись блока для отчёта/журнала, необязательно
// opts.platformOf — function(row) → 'meta'|'google'|'yandex'|'tiktok', если площадка известна
//                   из источника (тогда одинаковые имена разных площадок не склеятся)
// ===========================================================================

function mergeCampaignRows(rows, opts) {
  opts = opts || {};
  if (!rows || !rows.length) return [];
  var merges = opts.merges || null;
  var label = opts.label || '';
  var platformOf = typeof opts.platformOf === 'function' ? opts.platformOf : null;

  // 1. Разбор строк
  var items = [], passthrough = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var name = row[1] == null ? '' : String(row[1]).trim();
    if (!name || row[0] === '' || row[0] === null || row[0] === undefined) {
      passthrough.push(row);
      continue;
    }
    var info = cmKeyInfo_(name);
    var plat = (platformOf && platformOf(row)) || info.platform || '';
    items.push({ row: row, idx: i, name: name, info: info, platform: plat });
  }

  // 2. Группы по ключу. Внутри ключа разделяем площадки; строка с нераспознанной
  //    площадкой присоединяется к группе, только если площадка у ключа одна.
  var byKey = {}, keyOrder = [];
  items.forEach(function (it) {
    if (!byKey[it.info.key]) { byKey[it.info.key] = []; keyOrder.push(it.info.key); }
    byKey[it.info.key].push(it);
  });

  var groups = [];
  keyOrder.forEach(function (k) {
    var list = byKey[k];
    var byPlat = {}, platOrder = [], unknown = [];
    list.forEach(function (it) {
      if (!it.platform) { unknown.push(it); return; }
      if (!byPlat[it.platform]) { byPlat[it.platform] = []; platOrder.push(it.platform); }
      byPlat[it.platform].push(it);
    });
    if (platOrder.length === 0) { groups.push(unknown); return; }
    if (platOrder.length === 1) { groups.push(byPlat[platOrder[0]].concat(unknown)); return; }
    platOrder.forEach(function (p) { groups.push(byPlat[p]); });   // разные площадки — отдельно
    unknown.forEach(function (it) { groups.push([it]); });          // неясная площадка — не трогаем
  });

  groups.forEach(function (g) { g.sort(function (x, y) { return x.idx - y.idx; }); });
  groups.sort(function (x, y) { return x[0].idx - y[0].idx; });

  // 3. Сборка результата
  var out = [];
  groups.forEach(function (its) {
    if (its.length === 1) { out.push(its[0].row); return; }   // одиночка — без изменений

    var latest = 0;
    its.forEach(function (t) { latest = Math.max(latest, cmTime_(t.row[0])); });
    var datesDiffer = its.some(function (t) { return cmTime_(t.row[0]) !== latest; });

    var used = its;
    if (CAMPAIGN_MERGE.datePolicy === 'latest' && latest > 0) {
      used = its.filter(function (t) { return cmTime_(t.row[0]) === latest; });
    }

    var s = { impr: 0, reach: 0, clicks: 0, conv: 0, cost: 0 };
    used.forEach(function (t) {
      s.impr   += cmNum_(t.row[2]);
      s.reach  += cmNum_(t.row[3]);
      s.clicks += cmNum_(t.row[4]);
      s.conv   += cmNum_(t.row[5]);
      s.cost   += cmNum_(t.row[6]);
    });

    // Имя: без _vN → больший расход → короче → раньше в листе
    var best = used.slice().sort(function (x, y) {
      if (x.info.hadVer !== y.info.hadVer) return x.info.hadVer ? 1 : -1;
      var dc = cmNum_(y.row[6]) - cmNum_(x.row[6]);
      if (dc !== 0) return dc;
      if (x.name.length !== y.name.length) return x.name.length - y.name.length;
      return x.idx - y.idx;
    })[0];

    var dateItem = its[0];
    its.forEach(function (t) { if (cmTime_(t.row[0]) === latest) dateItem = t; });

    out.push([dateItem.row[0], best.name,
              cmClean_(s.impr), cmClean_(s.reach), cmClean_(s.clicks),
              cmClean_(s.conv), cmClean_(s.cost)]);

    if (merges) {
      var type = its.some(function (t) { return t.info.hadVer; })
        ? 'версия _vN' : 'регистр / пробелы / _';
      if (datesDiffer) {
        type += CAMPAIGN_MERGE.datePolicy === 'latest'
          ? ' | ⚠ разные даты — взяты строки за ' + cmDateText_(dateItem.row[0])
          : ' | ⚠ разные даты — просуммированы';
      }
      merges.push({
        block: label,
        name: best.name,
        members: its.map(function (t) {
          return t.name + ' (' + cmDateText_(t.row[0]) + ', ' + cmClean_(cmNum_(t.row[6])) + ')';
        }),
        rows: its.length,
        cost: cmClean_(s.cost),
        type: type
      });
    }
  });

  return out.concat(passthrough);
}

// ===========================================================================
// Склейка всего листа A:G (все блоки «месяц …»). Разметку листа сохраняет:
// строки до первого блока и число пустых строк перед каждым блоком остаются как были.
// Возвращает { values, changed, merges, rowsBefore, rowsAfter }.
// ===========================================================================

function mergeAdsDataValues(values, opts) {
  opts = opts || {};
  var width = 7;
  var blank = function () { var r = []; for (var c = 0; c < width; c++) r.push(''); return r; };
  var fit = function (row) { var r = []; for (var c = 0; c < width; c++) r.push(row[c] === undefined ? '' : row[c]); return r; };

  var head = [], blocks = [], cur = null, blanks = 0, dataBefore = 0;

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var a = row[0] instanceof Date ? '' : String(row[0] == null ? '' : row[0]).trim();
    var isBlank = row.slice(0, width).every(function (v) {
      return !(v instanceof Date) && String(v == null ? '' : v).trim() === '';
    });

    if (/^месяц\s/i.test(a)) {
      cur = { header: fit(row), gap: blanks, rows: [] };
      blocks.push(cur);
      blanks = 0;
      continue;
    }
    if (isBlank) { blanks++; continue; }
    if (!cur) {
      for (var g = 0; g < blanks; g++) head.push(blank());
      head.push(fit(row));
    } else {
      cur.rows.push(fit(row));
      dataBefore++;
    }
    blanks = 0;
  }

  var merges = [];
  var out = head.slice();
  var dataAfter = 0;

  blocks.forEach(function (bl) {
    for (var k = 0; k < bl.gap; k++) out.push(blank());
    out.push(bl.header);
    var merged = mergeCampaignRows(bl.rows, {
      merges: merges,
      label: String(bl.header[0]).trim(),
      platformOf: opts.platformOf
    });
    merged.forEach(function (r) { out.push(fit(r)); });
    dataAfter += merged.length;
  });

  return {
    values: out,
    changed: merges.length > 0,
    merges: merges,
    rowsBefore: dataBefore,
    rowsAfter: dataAfter
  };
}

/** Склейка на одном листе. opts.dryRun = true — только посчитать, не писать. */
function mergeAdsDataSheet_(sheet, opts) {
  opts = opts || {};
  var last = sheet.getLastRow();
  if (last < 1) return { values: [], changed: false, merges: [], rowsBefore: 0, rowsAfter: 0 };

  var values = sheet.getRange(1, 1, last, 7).getValues();
  var res = mergeAdsDataValues(values, opts);

  if (res.changed && !opts.dryRun) {
    sheet.getRange(1, 1, last, 7).clearContent();
    if (res.values.length) sheet.getRange(1, 1, res.values.length, 7).setValues(res.values);
    SpreadsheetApp.flush();
  }
  return res;
}

// ===========================================================================
// СПИСОК МП ИЗ REGISTRY
// ===========================================================================

function cmExtractId_(v) {
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/\/spreadsheets\/d\/([-\w]{25,})/);
  if (m) return m[1];
  if (/^[-\w]{40,60}$/.test(s)) return s;
  return '';
}

function cmMpList_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CAMPAIGN_MERGE.REGISTRY_SHEET);
  if (!sh) throw new Error('В Hub нет вкладки «' + CAMPAIGN_MERGE.REGISTRY_SHEET + '»');

  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var head = data[0].map(function (h) { return String(h).trim(); });
  var lowHead = head.map(function (h) { return h.toLowerCase(); });

  var idCol = -1;
  if (CAMPAIGN_MERGE.REGISTRY_ID_HEADER) {
    idCol = lowHead.indexOf(CAMPAIGN_MERGE.REGISTRY_ID_HEADER.toLowerCase());
    if (idCol < 0) throw new Error('В Registry нет колонки «' + CAMPAIGN_MERGE.REGISTRY_ID_HEADER + '»');
  } else {
    var best = null;
    for (var c = 0; c < head.length; c++) {
      var cnt = 0;
      for (var r = 1; r < data.length; r++) if (cmExtractId_(data[r][c])) cnt++;
      if (!cnt) continue;
      var score = cnt;
      if (/(^|[^a-zа-я])(mp|мп)([^a-zа-я]|$)|media|медиа/i.test(head[c])) score += 1000;
      if (/autoreport|hub|mapping|source|old|стар/i.test(head[c])) score -= 1000;
      if (!best || score > best.score) best = { col: c, score: score };
    }
    if (!best) throw new Error('В Registry не найдено ни одной ссылки на таблицу. Заголовки: ' + head.join(' | '));
    idCol = best.col;
  }

  var nameCol = lowHead.indexOf(String(CAMPAIGN_MERGE.REGISTRY_NAME_HEADER).toLowerCase());
  if (nameCol < 0) nameCol = 0;

  var activeCol = -1;
  for (var h = 0; h < lowHead.length; h++) {
    if (/^(active|enabled|is_active|вкл|включен|активен|активно)/.test(lowHead[h])) { activeCol = h; break; }
  }

  var list = [], seen = {};
  for (var i = 1; i < data.length; i++) {
    var id = cmExtractId_(data[i][idCol]);
    if (!id || seen[id]) continue;
    if (activeCol > -1) {
      var av = String(data[i][activeCol]).trim().toLowerCase();
      if (data[i][activeCol] === false || av === 'false' || av === 'нет' || av === '0' || av === 'no') continue;
    }
    seen[id] = true;
    list.push({ name: String(data[i][nameCol] || id).trim(), id: id });
  }
  Logger.log('Registry: колонка МП = «' + head[idCol] + '», таблиц к обработке: ' + list.length);
  return list;
}

// ===========================================================================
// ЗАПУСК
// ===========================================================================

function previewDuplicatesTestMp() { cmRunList_([cmTestMp_()], true); }
function mergeDuplicatesTestMp()   { cmRunList_([cmTestMp_()], false); }
function previewDuplicatesAllMp()  { cmRunList_(cmMpList_(), true); }
function mergeDuplicatesAllMp()    { cmRunList_(cmMpList_(), false); }

/** Точка входа для ежедневного триггера. */
function cmTriggerMergeAll() { cmRunList_(cmMpList_(), false); }

function cmTestMp_() {
  var id = cmExtractId_(CAMPAIGN_MERGE.TEST_MP);
  if (!id) throw new Error('CAMPAIGN_MERGE.TEST_MP: вставь ссылку или ID таблицы МП');
  return { name: 'TEST_MP', id: id };
}

function cmRunList_(list, dryRun) {
  var started = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(120000)) {
    Logger.log('⏭️ Склейка пропущена: проект занят другой операцией (lock 2 мин.)');
    return;
  }

  var stamp = new Date();
  var status = dryRun ? 'предпросмотр' : 'записано';
  var report = [];
  var tot = { mp: 0, touched: 0, merges: 0, rowsCut: 0, errors: 0, skipped: 0 };

  try {
    Logger.log((dryRun ? '👀 ПРЕДПРОСМОТР' : '🔗 СКЛЕЙКА') + ' дублей кампаний: МП в очереди — ' + list.length);

    for (var i = 0; i < list.length; i++) {
      if (Date.now() - started > CAMPAIGN_MERGE.maxRunMs) {
        tot.skipped = list.length - i;
        Logger.log('⏱ Остановлено по времени, не обработано МП: ' + tot.skipped + ' — запусти ещё раз');
        break;
      }
      var mp = list[i];
      try {
        var ss = SpreadsheetApp.openById(mp.id);
        var label = mp.name === 'TEST_MP' ? ss.getName() : mp.name;
        var sh = ss.getSheetByName(CAMPAIGN_MERGE.ADS_SHEET);
        if (!sh) {
          Logger.log('⏭️ ' + label + ': нет вкладки «' + CAMPAIGN_MERGE.ADS_SHEET + '»');
          report.push([stamp, label, '', '', 'нет вкладки «' + CAMPAIGN_MERGE.ADS_SHEET + '»', '', '', '', 'пропущено']);
          continue;
        }
        tot.mp++;
        var res = mergeAdsDataSheet_(sh, { dryRun: dryRun });
        if (!res.merges.length) { Logger.log('✅ ' + label + ': дублей нет'); continue; }

        tot.touched++;
        tot.merges += res.merges.length;
        tot.rowsCut += res.rowsBefore - res.rowsAfter;
        Logger.log('🔗 ' + label + ': склеек ' + res.merges.length +
                   ', строк ' + res.rowsBefore + ' → ' + res.rowsAfter);
        res.merges.forEach(function (m) {
          Logger.log('   [' + m.block + '] ' + m.name + '  ←  ' + m.members.join('  +  ') + '  |  ' + m.type);
          report.push([stamp, label, m.block, m.name, m.members.join('\n'), m.rows, m.cost, m.type, status]);
        });
      } catch (e) {
        tot.errors++;
        Logger.log('❌ ' + mp.name + ': ' + e.message);
        report.push([stamp, mp.name, '', '', e.message, '', '', '', 'ошибка']);
      }
    }
  } finally {
    lock.releaseLock();
  }

  cmWriteReport_(report);
  Logger.log('');
  Logger.log('Итого: МП проверено ' + tot.mp + ', с дублями ' + tot.touched +
             ', склеек ' + tot.merges + ', строк убрано ' + tot.rowsCut +
             ', ошибок ' + tot.errors + (tot.skipped ? ', не успели ' + tot.skipped : '') +
             (dryRun ? ' — ПРЕДПРОСМОТР, в МП ничего не записано' : ''));
}

function cmWriteReport_(rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CAMPAIGN_MERGE.REPORT_SHEET) || ss.insertSheet(CAMPAIGN_MERGE.REPORT_SHEET);
  sh.clearContents();
  var header = ['Время', 'МП', 'Блок', 'Итоговое имя', 'Склеено из (дата, расход)',
                'Строк', 'Расход итого', 'Тип склейки', 'Статус'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm');
    sh.getRange(2, 5, rows.length, 1).setWrap(true);
  } else {
    sh.getRange(2, 1).setValue('Дублей не найдено');
  }
  sh.setFrozenRows(1);
}

// ===========================================================================
// ТРИГГЕР
// ===========================================================================

function installCampaignMergeTrigger() {
  removeCampaignMergeTrigger();
  ScriptApp.newTrigger('cmTriggerMergeAll').timeBased()
    .atHour(CAMPAIGN_MERGE.triggerHour).everyDays(1).create();
  Logger.log('⏰ Склейка дублей: ежедневно около ' + CAMPAIGN_MERGE.triggerHour +
             ':00 (часовой пояс проекта). Ставь ПОСЛЕ ежедневной выгрузки Hub.');
}

function removeCampaignMergeTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'cmTriggerMergeAll') { ScriptApp.deleteTrigger(t); n++; }
  });
  if (n) Logger.log('🧹 Удалено триггеров склейки: ' + n);
}