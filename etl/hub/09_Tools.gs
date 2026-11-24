/**
 * 09_Tools.gs — вспомогательные инструменты.
 *
 * menuListGoogleConversions():
 *   На АКТИВНОМ листе берёт ID аккаунтов Google Ads из колонки A (со 2-й строки),
 *   для каждого запрашивает, какие действия-конверсии давали конверсии
 *   с CONV_LIST_FROM по вчера, и пишет:
 *     B — названия через запятую (сортировка по убыванию конверсий) — готово для google_conv_include
 *     C — те же названия с количеством: "name (123), name2 (45)"
 *   Ошибка по аккаунту пишется в C.
 */

var CONV_LIST_FROM = '2025-01-01';

function menuListGoogleConversions() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  var last = sh.getLastRow();
  if (last < 2) { ui.alert('На активном листе нет ID в колонке A (начиная со 2-й строки)'); return; }

  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  var now = new Date();
  var y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var dt = makeDateStr(y.getFullYear(), y.getMonth() + 1, y.getDate());

  var outB = [], outC = [], done = 0, errors = 0, start = Date.now();

  for (var i = 0; i < ids.length; i++) {
    var cid = String(ids[i][0] || '').trim();
    if (!cid) { outB.push(['']); outC.push(['']); continue; }
    if (Date.now() - start > HUB.MAX_RUN_MS) { outB.push(['']); outC.push(['⏱ не успел — запусти ещё раз']); continue; }
    try {
      var list = googleConversionActions_(cid, CONV_LIST_FROM, dt);
      outB.push([list.map(function (x) { return x.name; }).join(', ')]);
      outC.push([list.map(function (x) { return x.name + ' (' + Math.round(x.conv) + ')'; }).join(', ')]);
      done++;
    } catch (e) {
      outB.push(['']);
      outC.push(['❌ ' + String(e.message).substring(0, 300)]);
      errors++;
    }
  }

  sh.getRange(2, 2, outB.length, 1).setValues(outB);
  sh.getRange(2, 3, outC.length, 1).setValues(outC);
  if (String(sh.getRange(1, 3).getValue()).trim() === '') sh.getRange(1, 3).setValue('конверсии (количество)').setFontWeight('bold');
  ui.alert('Готово: ' + done + ' аккаунтов, ошибок: ' + errors + '.\nПериод: ' + CONV_LIST_FROM + ' — ' + dt);
}

/** [{name, conv}] по убыванию conv. */
function googleConversionActions_(customerId, df, dt) {
  var q = "SELECT segments.conversion_action_name, metrics.conversions " +
          "FROM campaign WHERE segments.date BETWEEN '" + df + "' AND '" + dt + "' " +
          "AND metrics.conversions > 0";
  var agg = {};
  gadsQuery_(customerId, q).forEach(function (r) {
    var name = String(r.segments && r.segments.conversionActionName || '').trim();
    if (!name) return;
    agg[name] = (agg[name] || 0) + (parseFloat(r.metrics && r.metrics.conversions) || 0);
  });
  return Object.keys(agg)
    .map(function (k) { return { name: k, conv: agg[k] }; })
    .sort(function (a, b) { return b.conv - a.conv; });
}