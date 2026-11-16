// Классификация кампаний — перенос 1:1 из Apps Script (GoogleAds_ETL.gs, ноябрь 2026):
//   detectByCampaignName_, isYouTubeCampaignName_, isLeadGenCampaignName_,
//   isPerfOverPlacementCampaignName_, isServiceCampaignName_, mapApiObjective,
//   detectMarketingObjective, loadDictionaries, parseCampaignName, pickModelFieldWaterfall.
// Регулярные выражения и порядок проверок сохранены дословно: от них зависят
// Marketing_Objective и Car_Model в отчётах. История каждой правки — в комментариях оригинала.

export const SERVICE_MODEL_VALUE = 'Service';
const MODEL_STRICT_SHORT_TOKENS = true;

export function isYouTubeCampaignName(campName) {
  if (!campName) return false;
  const s = campName.toString().toLowerCase();
  if (s.indexOf('youtube') > -1) return true;
  return /(^|[^a-z0-9а-яё])yt([^a-z0-9а-яё]|$)/i.test(s);
}

export function isLeadGenCampaignName(campName) {
  if (!campName) return false;
  const s = campName.toString().toLowerCase();
  return /(^|[^a-z0-9а-яё])(lf|lead|leads|leadform|leadgen|whatsapp|cpl|лид|лиды|лидформа|лидген)([^a-z0-9а-яё]|$)/i.test(s);
}

export function isPerfOverPlacementCampaignName(campName) {
  if (!campName) return false;
  const s = campName.toString().toLowerCase();
  if (!/(^|[^a-z0-9а-яё])(perf|performance|перформанс)([^a-z0-9а-яё]|$)/i.test(s)) return false;
  if (/video|видео|cpv|просмотр/i.test(s)) return false;
  return true;
}

export function isServiceCampaignName(name) {
  if (!name) return false;
  const s = name.toString().toLowerCase();
  return s.indexOf('service') > -1 || s.indexOf('servis') > -1 || s.indexOf('сервис') > -1;
}

export function detectByCampaignName(campName) {
  if (!campName) return 'Another';
  const s = campName.toLowerCase();
  if (isYouTubeCampaignName(s)) return 'Awareness';
  if (isLeadGenCampaignName(s)) return 'Performance';
  if (isPerfOverPlacementCampaignName(s)) return 'Performance';
  if (/awar|awareness|reach|cpm|cpv|gdn|\byt\b|youtube|video|image|brand|rsy|охват|имидж|видео|бренд/i.test(s)) return 'Awareness';
  if (/perf|performance|conversion|leadgen|search|pmax|dgen|epk|конверс|лидген|поиск|перформанс/i.test(s)) return 'Performance';
  return 'Another';
}

export function mapApiObjective(apiObj) {
  if (!apiObj) return 'Another';
  const o = apiObj.toString().toUpperCase();
  if (/OUTCOME_SALES|OUTCOME_LEADS|OUTCOME_TRAFFIC|OUTCOME_APP_PROMOTION/.test(o)) return 'Performance';
  if (/CONVERSIONS|LEAD_GENERATION|LINK_CLICKS|APP_INSTALLS|MESSAGES|CATALOG_SALES|PRODUCT_SALES|STORE_VISITS/.test(o)) return 'Performance';
  if (/SEARCH|SHOPPING|PERFORMANCE_MAX|MULTI_CHANNEL|DEMAND_GEN|DISCOVERY|HOTEL|LOCAL_SERVICES|TRAVEL/.test(o)) return 'Performance';
  if (/WEB_CONVERSIONS|LANDING_PAGE|^TRAFFIC$|APP_PROMOTION/.test(o)) return 'Performance';
  if (/TEXT_CAMPAIGN|DYNAMIC_TEXT|SMART_CAMPAIGN|UNIFIED_CAMPAIGN|MOBILE_APP_CAMPAIGN|UNIFIED_PERFORMANCE/.test(o)) return 'Performance';
  if (/OUTCOME_AWARENESS|OUTCOME_ENGAGEMENT|BRAND_AWARENESS|REACH|VIDEO_VIEWS|ENGAGEMENT|PAGE_LIKES|POST_ENGAGEMENT/.test(o)) return 'Awareness';
  if (/^DISPLAY$|^VIDEO$/.test(o)) return 'Awareness';
  if (/^REACH$|VIDEO_VIEWS|COMMUNITY/.test(o)) return 'Awareness';
  if (/CPM_BANNER|CPM_VIDEO|CPM_PRICE|CONTENT_PROMOTION/.test(o)) return 'Awareness';
  return 'Another';
}

export function detectMarketingObjective(campName, apiObjective) {
  const byName = detectByCampaignName(campName);
  if (byName === 'Awareness' && apiObjective && !isYouTubeCampaignName(campName)) {
    if (/OUTCOME_LEADS|LEAD_GENERATION/.test(apiObjective.toString().toUpperCase())) return 'Performance';
  }
  if (byName !== 'Another') return byName;
  const byApi = mapApiObjective(apiObjective);
  if (byApi !== 'Another') return byApi;
  return 'Another';
}

/**
 * Словари из листа Dictionaries (A: Category, B: Search_Keyword, C: Final_Value, D: Brand_Condition).
 * @param {unknown[][]} values  все строки листа, включая заголовок
 */
export function buildDictionaries(values) {
  const dicts = { brands: [], models: [], types: [], objectives: [] };
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const category = row[0] ? row[0].toString().trim() : '';
    const keywordRaw = row[1] ? row[1].toString().trim().toLowerCase() : '';
    const finalValue = row[2] ? row[2].toString().trim() : '';
    const brandCond = row[3] ? row[3].toString().trim().toLowerCase() : '';
    if (!keywordRaw || !finalValue) continue;
    if (category === 'Brand') dicts.brands.push({ k: keywordRaw, v: finalValue });
    else if (category === 'Model') dicts.models.push({ k: keywordRaw, v: finalValue, brandCond });
    else if (category === 'Type') dicts.types.push({ k: keywordRaw, v: finalValue });
    else if (category === 'Objective') dicts.objectives.push({ k: keywordRaw, v: finalValue });
  }
  const byComplexity = (a, b) => {
    const wa = a.k.split(' ').length;
    const wb = b.k.split(' ').length;
    if (wa !== wb) return wb - wa;
    return b.k.length - a.k.length;
  };
  dicts.brands.sort(byComplexity);
  dicts.models.sort(byComplexity);
  dicts.types.sort(byComplexity);
  dicts.objectives.sort(byComplexity);
  return dicts;
}

function cleanToken(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9а-я]/g, '');
}

function tokenizeText(str) {
  const parts = (str || '').split(/[\s_\-,.|/\\*;:!?()[\]{}'"#@&+=<>~`^%$№]+/);
  const out = [];
  for (const p of parts) {
    const c = cleanToken(p);
    if (c.length > 0) out.push(c);
  }
  return out;
}

function splitKey(dictKeyword) {
  const parts = (dictKeyword || '').toLowerCase().split(/[\s_\-,.]+/);
  const out = [];
  for (const p of parts) {
    const c = cleanToken(p);
    if (c.length > 0) out.push(c);
  }
  return out;
}

function totalLen(k) {
  return splitKey(k).reduce((s, t) => s + t.length, 0);
}

export function parseCampaignName(campName, dealerId, dicts) {
  const rawString = (campName + ' ' + dealerId).toLowerCase();
  const result = { brand: 'Other', model: 'Other', type: 'Другой тип', objective: 'Another' };
  const textTokens = tokenizeText(rawString);

  function isTokenMatch(keyTokens) {
    if (MODEL_STRICT_SHORT_TOKENS) {
      for (const skt of keyTokens) {
        let found = false;
        for (const stj of textTokens) {
          if (stj === skt) { found = true; break; }
          if (skt.length >= 2 && stj.indexOf(skt) === 0) { found = true; break; }
        }
        if (!found) return false;
      }
      return true;
    }
    for (const kt of keyTokens) {
      if (!textTokens.some((t) => t === kt || t.indexOf(kt) === 0)) return false;
    }
    return true;
  }

  function isAdjacentStripMatch(strippedKey) {
    for (let i = 0; i < textTokens.length; i++) {
      let acc = '';
      for (let j = i; j < textTokens.length; j++) {
        acc += textTokens[j];
        if (acc === strippedKey) return true;
        if (acc.length > strippedKey.length) break;
      }
    }
    return false;
  }

  function isMatch(dictKeyword) {
    const kts = splitKey(dictKeyword);
    if (kts.length === 0) return false;
    if (isTokenMatch(kts)) return true;
    return isAdjacentStripMatch(kts.join(''));
  }

  const byLenDesc = (a, b) => totalLen(b.k) - totalLen(a.k);

  const sortedBrands = dicts.brands.slice().sort(byLenDesc);
  for (const b of sortedBrands) {
    if (isMatch(b.k)) { result.brand = b.v; break; }
  }

  const matchedModels = [];
  for (const rule of dicts.models) {
    if (rule.brandCond && result.brand.toLowerCase() !== rule.brandCond.toLowerCase()) continue;
    if (isMatch(rule.k) && matchedModels.indexOf(rule.v) === -1) matchedModels.push(rule.v);
  }
  if (matchedModels.length === 1) {
    result.model = matchedModels[0];
  } else if (matchedModels.length > 1) {
    const mostSpecific = matchedModels.filter((v) => !matchedModels.some((other) =>
      other !== v && other.length > v.length && other.toLowerCase().indexOf(v.toLowerCase()) === 0));
    result.model = mostSpecific[0] || matchedModels[0];
  }

  if (result.model === 'Other' && isServiceCampaignName(rawString)) result.model = SERVICE_MODEL_VALUE;

  const sortedTypes = dicts.types.slice().sort(byLenDesc);
  for (const t of sortedTypes) {
    if (isMatch(t.k)) { result.type = t.v; break; }
  }
  const sortedObj = dicts.objectives.slice().sort(byLenDesc);
  for (const o of sortedObj) {
    if (isMatch(o.k)) { result.objective = o.v; break; }
  }
  return result;
}

export function pickModelFieldWaterfall(cName, agName, adName, dealerId, dicts) {
  const candidates = [];
  const mCamp = parseCampaignName(cName, dealerId, dicts).model;
  if (mCamp !== 'Other') candidates.push({ field: 'camp', model: mCamp });
  if (agName) {
    const mAg = parseCampaignName(agName, dealerId, dicts).model;
    if (mAg !== 'Other') candidates.push({ field: 'ag', model: mAg });
  }
  if (adName) {
    const mAd = parseCampaignName(adName, dealerId, dicts).model;
    if (mAd !== 'Other') candidates.push({ field: 'ad', model: mAd });
  }
  if (candidates.length === 0) {
    if (isServiceCampaignName(cName)) return { field: 'camp', model: SERVICE_MODEL_VALUE };
    if (isServiceCampaignName(agName)) return { field: 'ag', model: SERVICE_MODEL_VALUE };
    if (isServiceCampaignName(adName)) return { field: 'ad', model: SERVICE_MODEL_VALUE };
    return { field: null, model: 'Other' };
  }
  const models = candidates.map((c) => c.model);
  const mostSpecific = models.filter((v) => !models.some((other) =>
    other !== v && other.length > v.length && other.toLowerCase().indexOf(v.toLowerCase()) === 0));
  const winner = mostSpecific[0] || models[0];
  return candidates.filter((c) => c.model === winner)[0];
}
