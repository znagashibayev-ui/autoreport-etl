/**
 * 04_TikTok.gs — выгрузка TikTok Ads (несколько advertiser_id на дилера).
 * Registry: tiktok_adv_ids — "7599973235241025552, 7670785285353013268"
 *           tiktok_token_key — имя свойства с токеном, если не общий TIKTOK_TOKEN
 *
 * ИЗМЕНЕНО:
 *   T1. Правила Mapping с аккаунтом (колонка C = advertiser_id) применяются к кампаниям
 *       этого кабинета ДО сложения кабинетов по имени.
 */

function fetchTikTok(dealer, df, dt, disp) {
  var ids = splitIds(dealer.tiktok_adv_ids).filter(function (x) { return /^\d+$/.test(x); });
  if (!ids.length) return null;
  var token = tokenFor(dealer, 'tiktok');
  var agg = {};
  ids.forEach(function (adv) { tiktokReport_(adv, token, df, dt, agg); });

  var out = [];
  Object.keys(agg).forEach(function (k) {
    var s = agg[k];
    if (!rowHasData(s.impr, s.clicks, s.conv, s.cost)) return;
    out.push([disp, k, s.impr, s.reach, s.clicks, Math.ceil(s.conv), s.cost]);
  });
  return out;
}

function tiktokReport_(advId, token, df, dt, agg) {
  var url = 'https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/';
  var dimensions = ['campaign_id'];
  var metrics = ['campaign_name', 'spend', 'impressions', 'clicks', 'engagements', 'reach', 'conversion'];
  var page = 1, totalPages = 1;

  while (page <= totalPages && page <= 20) {
    var qs = '?advertiser_id=' + advId +
      '&report_type=BASIC&data_level=AUCTION_CAMPAIGN' +
      '&dimensions=' + encodeURIComponent(JSON.stringify(dimensions)) +
      '&metrics=' + encodeURIComponent(JSON.stringify(metrics)) +
      '&start_date=' + df + '&end_date=' + dt +
      '&page=' + page + '&page_size=1000';

    var res = UrlFetchApp.fetch(url + qs, {
      method: 'get', headers: { 'Access-Token': token }, muteHttpExceptions: true
    });
    var json = JSON.parse(res.getContentText());
    if (json.code !== 0) throw new Error('TikTok ' + advId + ': ' + JSON.stringify(json.message || json).substring(0, 300));
    if (!json.data || !json.data.list) break;
    if (json.data.page_info && json.data.page_info.total_page) totalPages = json.data.page_info.total_page;

    json.data.list.forEach(function (row) {
      var m = row.metrics || {};
      var camp = mapCampaignForAccount(m.campaign_name, advId);   // T1
      if (!camp) return;
      if (!agg[camp]) agg[camp] = { impr: 0, reach: 0, clicks: 0, conv: 0, cost: 0 };
      agg[camp].impr   += parseInt(m.impressions) || 0;
      agg[camp].reach  += parseInt(m.reach) || 0;
      agg[camp].clicks += parseInt(m.engagements) || parseInt(m.clicks) || 0;
      agg[camp].conv   += parseFloat(m.conversion) || 0;
      agg[camp].cost   += parseFloat(m.spend) || 0;
    });
    page++;
  }
}

function tiktokSelfCheck_(token) {
  var res = UrlFetchApp.fetch('https://business-api.tiktok.com/open_api/v1.3/user/info/',
    { headers: { 'Access-Token': token }, muteHttpExceptions: true });
  var j = JSON.parse(res.getContentText());
  if (j.code !== 0) throw new Error(JSON.stringify(j.message || j).substring(0, 200));
  return 'OK, пользователь: ' + (j.data && j.data.display_name);
}