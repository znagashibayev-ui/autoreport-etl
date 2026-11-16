// Обнуление конверсий Awareness перед записью — перенос 1:1 из insertIntoBigQueryStrictSchema (GoogleAds_ETL.gs).
// В Apps Script шло после отсева пустых строк, поэтому и здесь вызывается после stripEmptyRows.
// Исключения: площадка Yandex (конверсии — явные цели Метрики), YouTube-кампании, дилеры BMW-группы,
// кампании из реестра keep (Meta: messaging / правила Hub; Google: правила Hub) — по префиксу имени.

import { isYouTubeCampaignName } from './classify.mjs';

export const AWARENESS_ZEROOUT_SKIP_PLATFORMS = ['Yandex'];

export function isBmwGroupDealer(dealerId) {
  const d = (dealerId || '').toString().toLowerCase();
  return d.indexOf('bmw') > -1 || d.indexOf('motorrad') > -1 || d.indexOf('mini') > -1;
}

/**
 * @param {object[]} rows  меняются на месте
 * @param {Record<string, string[]>} keep  Dealer_ID → имена кампаний в нижнем регистре (registerMessagingKeep_)
 * @returns {{rows: number, convs: number}} сколько обнулено
 */
export function awarenessZeroOut(rows, keep = {}) {
  let n = 0; let convs = 0;
  for (const r of rows) {
    if (!r || r.Marketing_Objective !== 'Awareness' || !(r.Conversions > 0)) continue;
    if (AWARENESS_ZEROOUT_SKIP_PLATFORMS.includes((r.Platform || '').toString())) continue;
    if (isYouTubeCampaignName(r.Campaign_Name)) continue;
    if (isBmwGroupDealer(r.Dealer_ID)) continue;
    const list = keep[(r.Dealer_ID || '').toString()];
    const low = (r.Campaign_Name || '').toString().toLowerCase();
    if (list && list.some((p) => low.indexOf(p) === 0)) continue;
    convs += r.Conversions; n++;
    r.Conversions = 0;
  }
  return { rows: n, convs };
}
