// Meta — перенос 1:1 из Apps Script runMetaETL_ForceReload (Force_load_Meta.gs): его вызывает ночной ре-синк,
// он и определяет итог в BigQuery. Вместе с ним — хуки месячного эталона:
//   Meta_HubRules.gs (mhrApplyHubEtalon_, «Результат» по правилам Hub, ad set, v23.0) и
//   Meta_LeadsOverride.gs (mloApplyLeadsEtalon_, «Лиды» вместо квалифицированных лидов в кабинетах MLO_ACCOUNTS).
// В оригинале MLO оборачивает MHR, так что итог всегда «сначала правила Hub, затем Лиды» — здесь так же.
// Хелперы из GoogleAds_ETL.gs: registerMessagingKeep_ (реестр keep), computeMetaAwarenessConvForBmwGroup_.
//
// Намеренные отличия от оригинала:
//   1. Ошибка Meta API в дневных или месячном запросе останавливает только этот кабинет, старые данные дилера в базе
//      не трогаются. Оригинал молча брал то, что успел скачать, и уже удалил срез дилера в BigQuery.
//   2. Повтор только при временных ошибках (сеть, 5xx, лимиты Meta); неисправимые (токен, права) — сразу ошибка.
//      Ошибки правил Hub / Лидов, как в оригинале, оставляют прежний эталон — и попадают в итог запуска.

import { detectMarketingObjective, parseCampaignName, pickModelFieldWaterfall } from '../lib/classify.mjs';
import { isBmwGroupDealer } from '../lib/zeroout.mjs';

const GRAPH = 'https://graph.facebook.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Временные ошибки Graph API: неизвестная/сервис/лимиты приложения, пользователя, кабинета (80000–80014)
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

/** Реестр кампаний, которые Awareness zero-out не обнуляет (registerMessagingKeep_). */
export function registerKeep(keep, dealerId, campName) {
  if (!dealerId || !campName) return;
  const list = (keep[dealerId] = keep[dealerId] || []);
  const low = campName.toString().toLowerCase();
  if (!list.includes(low)) list.push(low);
}

/* ===================== Конверсии строки (Force_load_Meta.gs) ===================== */

export function calculateTrueMetaConversions(actions, objective, dealerId, campName) {
  if (!actions) return 0;
  const dealerLower = dealerId.toLowerCase();
  const cName = campName ? campName.toLowerCase() : '';
  const obj = objective ? objective.toUpperCase() : '';
  if (cName.indexOf('subaru_service-parts') > -1 || cName.indexOf('subaru_service_parts') > -1) {
    let customVal = 0; let leadVal = 0;
    for (const a of actions) {
      const type = a.action_type.toLowerCase(); const val = parseInt(a.value) || 0;
      if (type === 'offsite_conversion.fb_pixel_custom' || type.indexOf('custom') > -1) customVal = Math.max(customVal, val);
      if (type === 'offsite_conversion.fb_pixel_lead' || type === 'lead') leadVal = Math.max(leadVal, val);
    }
    const ep = customVal - leadVal;
    return ep > 0 ? ep : customVal;
  }
  if (dealerLower.indexOf('changan') > -1) {
    let leadGrouped = 0; let pixelCustom = 0; let lead = 0; let pixelLead = 0; let initiateCheckout = 0;
    for (const a of actions) {
      const type = a.action_type.toLowerCase(); const val = parseFloat(a.value) || 0;
      if (type === 'onsite_conversion.lead_grouped') leadGrouped = Math.max(leadGrouped, val);
      if (type === 'offsite_conversion.fb_pixel_custom') pixelCustom = Math.max(pixelCustom, val);
      if (type === 'lead') lead = Math.max(lead, val);
      if (type === 'offsite_conversion.fb_pixel_lead') pixelLead = Math.max(pixelLead, val);
      if (type === 'initiate_checkout' || type === 'offsite_conversion.fb_pixel_initiate_checkout' || type === 'onsite_web_initiate_checkout') {
        initiateCheckout = Math.max(initiateCheckout, val);
      }
    }
    const lowerCamp = (campName || '').toLowerCase();
    const isInitiateCheckoutCampaign = ['шины', 'шина', 'трейд-ин', 'трейд ин', 'сервис', 'спецпредложение'].some((w) => lowerCamp.indexOf(w) > -1);
    if (isInitiateCheckoutCampaign && initiateCheckout > 0) return initiateCheckout;
    if (leadGrouped > 0) return leadGrouped;
    if (lead > 0) return lead;
    if (pixelLead > 0) return pixelLead;
    if (pixelCustom > 0) return pixelCustom;
    return 0;
  }
  if (dealerLower.indexOf('tank') > -1) {
    const t = { purchase: 0, pixel_purchase: 0, lead: 0, pixel_lead: 0, msg_7d: 0, msg_started: 0 };
    for (const a of actions) {
      const at = a.action_type.toLowerCase(); const val = parseInt(a.value) || 0;
      if (at === 'purchase') t.purchase += val;
      if (at === 'offsite_conversion.fb_pixel_purchase') t.pixel_purchase += val;
      if (at === 'lead') t.lead += val;
      if (at === 'offsite_conversion.fb_pixel_lead') t.pixel_lead += val;
      if (at === 'onsite_conversion.messaging_conversation_started_7d') t.msg_7d += val;
      if (at === 'messaging_conversation_started_7d') t.msg_started += val;
    }
    const fp = Math.max(t.purchase, t.pixel_purchase);
    let pfl = t.lead - t.pixel_lead; if (pfl < 0) pfl = 0;
    let fl = pfl > 0 ? pfl : t.pixel_lead; if (fl === 0) fl = t.lead;
    const fm = Math.max(t.msg_7d, t.msg_started);
    if (obj === 'OUTCOME_SALES' || obj === 'CONVERSIONS') { let mc = fp; if (mc === 0) mc = Math.max(fl, fm); return mc; }
    if (obj === 'OUTCOME_LEADS' || obj === 'LEAD_GENERATION') return Math.max(fl, fm);
    if (obj === 'OUTCOME_ENGAGEMENT' || obj === 'MESSAGES') { let mc = fm; if (mc === 0) mc = Math.max(fl, fp); return mc; }
    return Math.max(fp, fl, fm);
  }
  if (dealerLower.indexOf('chery') > -1 || dealerLower.indexOf('haval') > -1) {
    const c = { purchase: 0, pixel_purchase: 0, lead: 0, pixel_lead: 0, msg_7d: 0, msg_started: 0, custom: 0 };
    for (const a of actions) {
      const at = a.action_type.toLowerCase(); const val = parseInt(a.value) || 0;
      if (at === 'purchase') c.purchase = Math.max(c.purchase, val);
      if (at === 'offsite_conversion.fb_pixel_purchase') c.pixel_purchase = Math.max(c.pixel_purchase, val);
      if (at === 'lead') c.lead = Math.max(c.lead, val);
      if (at === 'offsite_conversion.fb_pixel_lead' || at.indexOf('register') > -1) c.pixel_lead = Math.max(c.pixel_lead, val);
      if (at === 'onsite_conversion.messaging_conversation_started_7d') c.msg_7d = Math.max(c.msg_7d, val);
      if (at === 'messaging_conversation_started_7d' || at.indexOf('message') > -1) c.msg_started = Math.max(c.msg_started, val);
      if (at.indexOf('custom') > -1 || at.indexOf('submit') > -1) c.custom = Math.max(c.custom, val);
    }
    const fpC = Math.max(c.purchase, c.pixel_purchase);
    let pflC = c.lead - c.pixel_lead; if (pflC < 0) pflC = 0;
    let flC = pflC > 0 ? pflC : c.pixel_lead; if (flC === 0) flC = c.lead;
    const fmC = Math.max(c.msg_7d, c.msg_started);
    if (obj === 'OUTCOME_SALES' || obj === 'CONVERSIONS') { let mc = fpC; if (mc === 0) mc = Math.max(flC, fmC, c.custom); return mc; }
    if (obj === 'OUTCOME_LEADS' || obj === 'LEAD_GENERATION') { if (pflC > 0) return pflC; return Math.max(flC, fmC, c.custom); }
    if (obj === 'OUTCOME_ENGAGEMENT' || obj === 'MESSAGES') { let mc = fmC; if (mc === 0) mc = Math.max(flC, fpC, c.custom); return mc; }
    return Math.max(fpC, flC, fmC);
  }
  const acts = { purchase: 0, pixel_purchase: 0, lead: 0, pixel_lead: 0, message: 0, custom: 0 };
  for (const a of actions) {
    const at = a.action_type.toLowerCase(); const val = parseInt(a.value) || 0;
    if (at === 'purchase') acts.purchase = Math.max(acts.purchase, val);
    if (at === 'offsite_conversion.fb_pixel_purchase') acts.pixel_purchase = Math.max(acts.pixel_purchase, val);
    if (at === 'lead') acts.lead = Math.max(acts.lead, val);
    if (at === 'offsite_conversion.fb_pixel_lead' || at.indexOf('submit') > -1 || at.indexOf('register') > -1) acts.pixel_lead = Math.max(acts.pixel_lead, val);
    if (at.indexOf('message') > -1 || at.indexOf('conversation') > -1) acts.message = Math.max(acts.message, val);
    if (at.indexOf('custom') > -1) acts.custom = Math.max(acts.custom, val);
  }
  const fpG = Math.max(acts.purchase, acts.pixel_purchase);
  let pflG = acts.lead - acts.pixel_lead;
  if (pflG < 0) pflG = 0;
  if (obj === 'OUTCOME_SALES' || obj === 'CONVERSIONS') { let mc = fpG; if (mc === 0) mc = Math.max(acts.pixel_lead, acts.custom, pflG); return mc; }
  if (obj === 'OUTCOME_LEADS' || obj === 'LEAD_GENERATION') { if (pflG > 0) return pflG; return Math.max(acts.pixel_lead, acts.custom); }
  if (obj === 'OUTCOME_ENGAGEMENT' || obj === 'MESSAGES') { let mc = acts.message; if (mc === 0) mc = acts.lead; return mc; }
  if (obj === 'OUTCOME_AWARENESS' || obj === 'BRAND_AWARENESS' || obj === 'REACH') return Math.max(acts.custom, acts.pixel_lead);
  if (dealerLower.indexOf('bmw') > -1 || dealerLower.indexOf('motorrad') > -1) return Math.max(fpG, pflG, acts.pixel_lead, acts.custom);
  return Math.max(fpG, pflG, acts.pixel_lead, acts.custom, acts.message);
}

function isWhatsAppCampaignName(name) {
  const n = (name || '').toLowerCase();
  if (n.indexOf('whatsapp') > -1 || n.indexOf('ватсап') > -1 || n.indexOf('вотсап') > -1) return true;
  return /(^|[^a-z0-9])wa([^a-z0-9]|$)/.test(n);
}

function getMessagingStarted7d(actions) {
  if (!actions || !actions.length) return 0;
  let v7d = 0;
  for (const a of actions) {
    const at = (a.action_type || '').toLowerCase();
    if (at === 'onsite_conversion.messaging_conversation_started_7d' || at === 'messaging_conversation_started_7d') {
      const v = parseInt(a.value) || 0;
      if (v > v7d) v7d = v;
    }
  }
  return v7d;
}

function hasLeadFunnelActions(actions) {
  if (!actions || !actions.length) return false;
  for (const a of actions) {
    const at = (a.action_type || '').toLowerCase();
    const v = parseInt(a.value) || 0;
    if (v <= 0) continue;
    if (at === 'lead' || at === 'onsite_conversion.lead_grouped' || at === 'offsite_conversion.fb_pixel_lead' ||
      at.indexOf('submit') > -1 || at.indexOf('register') > -1) return true;
  }
  return false;
}

/** computeMetaAwarenessConvForBmwGroup_ (GoogleAds_ETL.gs). */
export function computeMetaAwarenessConvForBmwGroup(row) {
  if (!row) return 0;
  let custom = 0; let pixelLead = 0; let pixelReg = 0;
  for (const a of row.actions || []) {
    const at = (a.action_type || '').toLowerCase();
    const v = parseInt(a.value) || 0;
    if (at.indexOf('custom') > -1) custom = Math.max(custom, v);
    if (at === 'offsite_conversion.fb_pixel_lead') pixelLead = Math.max(pixelLead, v);
    if (at === 'offsite_conversion.fb_pixel_complete_registration') pixelReg = Math.max(pixelReg, v);
  }
  let websiteConvMax = 0;
  for (const c of row.conversions || []) {
    const ct = (c.action_type || '').toLowerCase();
    const cv = parseFloat(c.value) || 0;
    if (ct.indexOf('website') > -1 || ct.indexOf('offsite') > -1) websiteConvMax = Math.max(websiteConvMax, cv);
  }
  return Math.round(Math.max(custom, pixelLead, pixelReg, websiteConvMax));
}

export function getMetaConversionFromRow(row, objective, dealerId, campName, keep = {}) {
  const actions = row ? row.actions : null;
  const objU = (objective || '').toString().toUpperCase();
  if (objU === 'OUTCOME_ENGAGEMENT' || objU === 'MESSAGES') {
    const s = getMessagingStarted7d(actions);
    if (s > 0) { registerKeep(keep, dealerId, campName); return s; }
  }
  if (isWhatsAppCampaignName(campName)) {
    const s = getMessagingStarted7d(actions);
    if (s > 0) { registerKeep(keep, dealerId, campName); return s; }
  }
  if (objU === 'OUTCOME_LEADS' || objU === 'LEAD_GENERATION') {
    const s = getMessagingStarted7d(actions);
    if (s > 0 && !hasLeadFunnelActions(actions)) {
      let mlConvMax = 0;
      if (row && row.conversions && row.conversions.length) {
        for (const c of row.conversions) { const v = parseFloat(c.value) || 0; if (v > mlConvMax) mlConvMax = v; }
      }
      if (mlConvMax === 0) { registerKeep(keep, dealerId, campName); return s; }
    }
  }
  if (isBmwGroupDealer(dealerId) && (objU === 'OUTCOME_AWARENESS' || objU === 'BRAND_AWARENESS' || objU === 'REACH')) {
    return computeMetaAwarenessConvForBmwGroup(row);
  }
  if (isBmwGroupDealer(dealerId) && (objU === 'LINK_CLICKS' || objU === 'OUTCOME_TRAFFIC')) {
    const s = getMessagingStarted7d(actions);
    if (s > 0 && !hasLeadFunnelActions(actions)) { registerKeep(keep, dealerId, campName); return s; }
  }

  const dLower = dealerId.toLowerCase();
  if (dLower.indexOf('changan') > -1 || dLower.indexOf('byd') > -1 || dLower.indexOf('chery') > -1) {
    return calculateTrueMetaConversions(actions, objective, dealerId, campName);
  }
  let leadGrouped = 0; let leadVal = 0; let pixelLeadVal = 0;
  if (row && row.actions && row.actions.length) {
    for (const a of row.actions) {
      const at = (a.action_type || '').toLowerCase(); const v = parseInt(a.value) || 0;
      if (at === 'onsite_conversion.lead_grouped') leadGrouped = Math.max(leadGrouped, v);
      if (at === 'lead') leadVal = Math.max(leadVal, v);
      if (at === 'offsite_conversion.fb_pixel_lead' || at.indexOf('submit') > -1 || at.indexOf('register') > -1) pixelLeadVal = Math.max(pixelLeadVal, v);
    }
  }
  let convMax = 0;
  if (row && row.conversions && row.conversions.length) {
    for (const c of row.conversions) { const cv = parseFloat(c.value) || 0; if (cv > convMax) convMax = cv; }
  }
  const obj = (objective || '').toString().toUpperCase();
  const campLow = (campName || '').toLowerCase();
  if ((campLow.indexOf('subaru_service-parts') > -1 || campLow.indexOf('subaru_service_parts') > -1) && convMax > 0) return convMax;
  const isLeadAds = leadGrouped > 0 || (pixelLeadVal === 0 && leadVal > 0 && convMax < leadVal);
  if (isLeadAds) return calculateTrueMetaConversions(row.actions, objective, dealerId, campName);
  const isConvObj = obj === 'OUTCOME_LEADS' || obj === 'LEAD_GENERATION' || obj === 'OUTCOME_SALES' || obj === 'CONVERSIONS';
  if (dLower.indexOf('subaru') > -1) return convMax > 0 ? convMax : 0;
  if (isConvObj && convMax > 0) return convMax;
  return calculateTrueMetaConversions(actions, objective, dealerId, campName);
}

/* ===================== Правила Hub (Meta_HubRules.gs) ===================== */

const MHR_API_VERSION = 'v23.0';
const MHR_NON_CONV_INDICATORS = ['landing_page_view', 'link_click', 'outbound_click', 'reach', 'impressions', 'video', 'thruplay',
  'post_engagement', 'page_engagement', 'post_reaction', 'like', 'profile_visit', 'ig_profile', 'instagram_profile', 'estimated_ad_recall'];
const MHR_NON_CONV_GOALS = new Set(['LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT', 'THRUPLAY',
  'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS', 'POST_ENGAGEMENT', 'PAGE_LIKES', 'PROFILE_VISIT', 'VISIT_INSTAGRAM_PROFILE', 'EVENT_RESPONSES']);
const MHR_SITE_CHECKOUT = ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout', 'omni_initiated_checkout', 'initiate_checkout_website'];
const MHR_SITE_OTHERS = [
  { name: 'Завершённые регистрации', types: ['offsite_conversion.fb_pixel_complete_registration', 'complete_registration', 'omni_complete_registration', 'complete_registration_website'] },
  { name: 'Добавления платёжной информации', types: ['offsite_conversion.fb_pixel_add_payment_info', 'add_payment_info', 'omni_add_payment_info', 'add_payment_info_website'] },
  { name: 'Покупки на сайте', types: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase', 'purchase_website'] }
];
const MHR_EVENT_ACTIONS = {
  PURCHASE: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase'],
  INITIATED_CHECKOUT: ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout', 'omni_initiated_checkout'],
  INITIATE_CHECKOUT: ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout', 'omni_initiated_checkout'],
  ADD_TO_CART: ['offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart', 'omni_add_to_cart'],
  ADD_PAYMENT_INFO: ['offsite_conversion.fb_pixel_add_payment_info', 'add_payment_info', 'omni_add_payment_info'],
  ADD_TO_WISHLIST: ['offsite_conversion.fb_pixel_add_to_wishlist', 'add_to_wishlist'],
  COMPLETE_REGISTRATION: ['offsite_conversion.fb_pixel_complete_registration', 'complete_registration', 'omni_complete_registration'],
  LEAD: ['offsite_conversion.fb_pixel_lead', 'lead', 'omni_lead'],
  CONTENT_VIEW: ['offsite_conversion.fb_pixel_view_content', 'view_content', 'omni_view_content'],
  VIEW_CONTENT: ['offsite_conversion.fb_pixel_view_content', 'view_content', 'omni_view_content'],
  SEARCH: ['offsite_conversion.fb_pixel_search', 'search', 'omni_search'],
  SUBSCRIBE: ['offsite_conversion.fb_pixel_subscribe', 'subscribe'],
  START_TRIAL: ['offsite_conversion.fb_pixel_start_trial', 'start_trial'],
  DONATE: ['offsite_conversion.fb_pixel_donate', 'donate'],
  CONTACT: ['offsite_conversion.fb_pixel_contact', 'contact'],
  SCHEDULE: ['offsite_conversion.fb_pixel_schedule', 'schedule'],
  SUBMIT_APPLICATION: ['offsite_conversion.fb_pixel_submit_application', 'submit_application'],
  CUSTOMIZE_PRODUCT: ['offsite_conversion.fb_pixel_customize_product'],
  FIND_LOCATION: ['offsite_conversion.fb_pixel_find_location'],
  MESSAGING_CONVERSATION_STARTED_7D: ['onsite_conversion.messaging_conversation_started_7d'],
  MESSAGING_APPOINTMENT_CONFIRMED: ['onsite_conversion.messaging_appointment_confirmed']
};
const MHR_GOAL_ACTIONS = {
  CONVERSATIONS: ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'],
  REPLIES: ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'],
  LEAD_GENERATION: ['onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_lead'],
  QUALITY_LEAD: ['onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_lead'],
  QUALITY_CALL: ['onsite_conversion.lead_grouped', 'lead'],
  LANDING_PAGE_VIEWS: ['landing_page_view'],
  LINK_CLICKS: ['link_click'],
  POST_ENGAGEMENT: ['post_engagement'],
  PAGE_LIKES: ['like'],
  EVENT_RESPONSES: ['rsvp'],
  APP_INSTALLS: ['mobile_app_install', 'omni_app_install'],
  THRUPLAY: ['video_view'],
  TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: ['video_view'],
  VALUE: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase'],
  OFFSITE_CONVERSIONS: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'offsite_conversion.fb_pixel_lead', 'lead']
};

function mhrActionsMap(actions, conversions) {
  const m = {};
  for (const list of [actions || [], conversions || []]) {
    for (const a of list) {
      const t = String(a.action_type || '').toLowerCase();
      const v = parseFloat(a.value) || 0;
      m[t] = Math.max(m[t] || 0, v);
    }
  }
  return m;
}

function mhrPickAction(acts, list) {
  let best = 0; let found = null;
  for (const k of list) {
    const key = String(k).toLowerCase();
    if (acts[key] !== undefined && acts[key] > best) { best = acts[key]; found = key; }
  }
  return found ? { value: best, source: found } : null;
}

function mhrResultsValue(results) {
  if (!results || !results.length) return null;
  let total = 0; let found = false; const names = [];
  for (const it of results) {
    if (!it) continue;
    names.push(String(it.indicator || '?').replace(/^actions:/, ''));
    const vals = it.values || [];
    if (!vals.length && it.value !== undefined) { total += parseFloat(it.value) || 0; found = true; continue; }
    let pickV = null;
    for (const v of vals) if (!pickV && (v.attribution_windows || []).indexOf('default') > -1) pickV = v;
    if (!pickV && vals.length) pickV = vals[0];
    if (pickV) total += parseFloat(pickV.value) || 0;
    found = true;
  }
  return found ? { value: total, source: 'results: ' + names.join(', '), indicators: names } : null;
}

function mhrIsNonConvIndicator(indicators) {
  if (!indicators || !indicators.length) return false;
  return indicators.every((ind) => MHR_NON_CONV_INDICATORS.some((w) => String(ind).toLowerCase().indexOf(w) > -1));
}

function mhrSiteEvent(acts, why) {
  const ic = mhrPickAction(acts, MHR_SITE_CHECKOUT);
  if (ic && ic.value > 0) return { value: ic.value, source: 'стратегия ' + why + ' → Начатые оформления заказа' };
  let best = null;
  for (const ev of MHR_SITE_OTHERS) {
    const p = mhrPickAction(acts, ev.types);
    if (p && p.value > 0 && (!best || p.value > best.value)) best = { value: p.value, name: ev.name };
  }
  if (best) return { value: best.value, source: 'стратегия ' + why + ' → ' + best.name };
  return { value: 0, source: 'стратегия ' + why + ', событий с сайта нет → 0' };
}

function mhrPickResult(acts, cfg) {
  if (cfg.customConvId) {
    const cc = mhrPickAction(acts, ['offsite_conversion.custom.' + cfg.customConvId]);
    if (cc) return cc;
  }
  if (cfg.event && MHR_EVENT_ACTIONS[cfg.event]) return mhrPickAction(acts, MHR_EVENT_ACTIONS[cfg.event]) || { value: 0, source: cfg.event + ' (0 за период)' };
  if (cfg.goal && MHR_GOAL_ACTIONS[cfg.goal]) return mhrPickAction(acts, MHR_GOAL_ACTIONS[cfg.goal]) || { value: 0, source: cfg.goal + ' (0 за период)' };
  if (cfg.goal === 'REACH' || cfg.goal === 'IMPRESSIONS' || cfg.goal === 'AD_RECALL_LIFT') return { value: 0, source: cfg.goal + ' (конверсий нет по определению)' };
  let fallback;
  if (cfg.objective === 'OUTCOME_SALES' || cfg.objective === 'CONVERSIONS') {
    fallback = ['offsite_conversion.fb_pixel_purchase', 'purchase', 'offsite_conversion.fb_pixel_initiate_checkout', 'offsite_conversion.fb_pixel_lead', 'lead'];
  } else if (cfg.objective === 'OUTCOME_LEADS' || cfg.objective === 'LEAD_GENERATION') {
    fallback = ['onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.messaging_conversation_started_7d'];
  } else if (cfg.objective === 'OUTCOME_ENGAGEMENT' || cfg.objective === 'MESSAGES') {
    fallback = ['onsite_conversion.messaging_conversation_started_7d', 'post_engagement'];
  } else if (cfg.objective === 'OUTCOME_TRAFFIC' || cfg.objective === 'LINK_CLICKS') {
    fallback = ['landing_page_view', 'link_click'];
  } else {
    fallback = ['offsite_conversion.fb_pixel_purchase', 'lead', 'onsite_conversion.messaging_conversation_started_7d', 'landing_page_view'];
  }
  const f = mhrPickAction(acts, fallback);
  return f ? { value: f.value, source: f.source + ' (по objective)' } : { value: 0, source: 'не определено' };
}

/** Раскладывает целое total по весам, сумма точно = total (метод наибольшего остатка). Веса ≥ 0, сумма весов > 0. */
export function splitIntByWeights(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !(total > 0)) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let j = 0; left > 0 && j < order.length; j++, left--) out[order[j][1]] += 1;
  return out;
}

/** «Результат» строки ad set — mhrResultFor_. */
export function mhrResultFor(r, meta) {
  const acts = mhrActionsMap(r.actions, r.conversions);
  const goal = meta.goal || String(r.optimization_goal || '').toUpperCase();
  const fromResults = mhrResultsValue(r.results);
  const nonConv = MHR_NON_CONV_GOALS.has(goal) || (fromResults && mhrIsNonConvIndicator(fromResults.indicators));
  if (nonConv) return mhrSiteEvent(acts, goal || (fromResults && fromResults.indicators.join(',')));
  if (fromResults) return fromResults;
  const pick = mhrPickResult(acts, { goal, event: meta.event || '', customConvId: meta.customConvId || '', objective: String(r.objective || '').toUpperCase() });
  return { value: pick.value, source: 'запасной путь: ' + pick.source };
}

/* ===================== «Лиды» вместо квалифицированных лидов (Meta_LeadsOverride.gs) ===================== */

const MLO_ACCOUNTS = ['1956899568474033'];
const MLO_QL_GOALS = new Set(['QUALITY_LEAD', 'CONVERSION_LEADS']);

function mloIsQualified(goal, indicators) {
  if (MLO_QL_GOALS.has(String(goal || '').toUpperCase())) return true;
  return (indicators || []).some((i) => /qualif|quality_lead|conversion_lead/i.test(String(i)));
}

/** «Лиды» из actions (MLO_LEAD_TYPE = 'ALL'). */
function mloLeads(actions) {
  let lead = null; let form = 0; let site = 0;
  for (const a of actions || []) {
    const t = String(a.action_type || '').toLowerCase();
    const v = parseFloat(a.value) || 0;
    if (t === 'lead') lead = Math.max(lead === null ? 0 : lead, v);
    if (t === 'onsite_conversion.lead_grouped') form = Math.max(form, v);
    if (t === 'offsite_conversion.fb_pixel_lead') site = Math.max(site, v);
  }
  return lead !== null ? lead : form + site;
}

/* ===================== Запросы к Graph API ===================== */

/** GET с повтором временных ошибок: {json} или {error}. Текст ошибки без URL (в нём токен). */
async function metaGet(url, fetchImpl, attempts, delayMs) {
  let err = '';
  for (let a = 0; a < attempts; a++) {
    let transient = true;
    try {
      const res = await fetchImpl(url);
      const text = await res.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        // так Meta отвечает, когда не может собрать слишком большой отчёт: обрывок JSON или HTML вместо ответа
        throw new Error('ответ Meta не JSON (HTTP ' + res.status + '): ' + text.slice(0, 120).replace(/access_token=[^&"\s]+/g, 'access_token=…'));
      }
      if (!j.error) return { json: j };
      const c = j.error.code;
      err = (j.error.message || 'ошибка') + ' (code ' + c + ')';
      transient = res.status >= 500 || j.error.is_transient === true || TRANSIENT_CODES.has(c) || (c >= 80000 && c <= 80014);
    } catch (e) {
      err = e.message;
    }
    if (!transient) break;
    if (a < attempts - 1) await sleep(delayMs(a));
  }
  return { error: err };
}

/** Все страницы (paging.next): {rows} или {error}. */
async function metaPages(url, fetchImpl, attempts, delayMs, maxPages = Infinity) {
  let rows = []; let page = 0;
  while (url && page++ < maxPages) {
    const r = await metaGet(url, fetchImpl, attempts, delayMs);
    if (r.error) return { error: r.error };
    if (r.json.data && r.json.data.length) rows = rows.concat(r.json.data);
    url = r.json.paging && r.json.paging.next ? r.json.paging.next : null;
  }
  return { rows };
}

/* ===================== Дилер × кабинет ===================== */

/**
 * Строки daily_statistics одного кабинета Meta за период — до пересчёта курсов, отсева пустых строк и обнуления Awareness.
 * @param {{dealerId: string, accountId: string, token: string, startDate: string, endDate: string, dicts: object,
 *          keep?: object, warn?: (s: string) => void, onChunk?: () => void, fetchImpl?: typeof fetch, retryMs?: number}} o
 */
export async function metaDealerRows(o) {
  const { dealerId, token, startDate, endDate, dicts } = o;
  const keep = o.keep || {};
  const warn = o.warn || (() => {});
  const tick = () => { if (o.onChunk) o.onChunk(); };
  const fetchImpl = o.fetchImpl || fetch;
  const retryMs = o.retryMs ?? 5000;
  const accountId = String(o.accountId).replace(/act_/g, '');
  const label = `Meta API [${dealerId} / act_${accountId}]`;
  // как fetchMetaPaginated: 5 попыток, паузы 5, 10, 20, 40 с
  const mainPages = async (url, what) => {
    const r = await metaPages(url, fetchImpl, 5, (a) => retryMs * 2 ** a);
    if (r.error) throw new Error(`${label} ${what}: ${r.error}`);
    return r.rows;
  };
  // Дневной отчёт (time_increment=1) за период; если Meta не может отдать его целиком («unknown error», обрывок ответа,
  // «reduce the amount of data») — период делится пополам, пока не уложится. Строки по дням, поэтому итог тот же.
  const dailyPages = async (urlFor, from, to, what) => {
    const r = await metaPages(urlFor(from, to), fetchImpl, from === to ? 5 : 3, (a) => retryMs * 2 ** a);
    if (!r.error) return r.rows;
    if (from === to || !/code 1\)|code 2\)|не JSON|reduce the amount|too much data/i.test(r.error)) throw new Error(`${label} ${what}: ${r.error}`);
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
    const mid = new Date(Date.parse(from) + Math.floor(days / 2) * 86400000).toISOString().slice(0, 10);
    const next = new Date(Date.parse(mid) + 86400000).toISOString().slice(0, 10);
    return (await dailyPages(urlFor, from, mid, what)).concat(await dailyPages(urlFor, next, to, what));
  };
  // как mhrGet_ / mloGet_: 3 попытки, паузы 5 и 10 с, не больше 30 страниц
  const hubPages = (url) => metaPages(url, fetchImpl, 3, (a) => retryMs * (a + 1), 30);

  const totalsByCamp = {}; const allocatedByCamp = {}; const aggregatedData = {}; const campObjectives = {};
  const modelSharesByCamp = {};
  const dl = dealerId.toLowerCase();
  const needsUnified = dl.indexOf('subaru') > -1 || dl.indexOf('bmw') > -1 || dl.indexOf('motorrad') > -1 || dl.indexOf('mini') > -1;
  const unifiedParam = needsUnified ? '&use_unified_attribution_setting=true' : '';
  const timeRange = encodeURIComponent('{"since":"' + startDate + '","until":"' + endDate + '"}');
  const base = GRAPH + 'v19.0/act_' + accountId + '/insights?';

  const range = (f, t) => encodeURIComponent('{"since":"' + f + '","until":"' + t + '"}');
  const campData = await dailyPages((f, t) => base + 'level=campaign&fields=campaign_id,campaign_name,objective,impressions,reach,clicks,spend,actions,conversions&time_range=' +
    range(f, t) + '&time_increment=1' + unifiedParam + '&limit=1000&access_token=' + token, startDate, endDate, 'дневные кампании');
  tick();
  for (const row of campData) {
    const date = row.date_start; const cName = row.campaign_name || '';
    const campK = date + '|||' + (row.campaign_id || cName);
    campObjectives[cName] = row.objective || '';
    const rowImpr = parseInt(row.impressions) || 0; const rowSpend = parseFloat(row.spend) || 0;
    if (!needsUnified && rowImpr <= 0) continue;
    const convs = getMetaConversionFromRow(row, row.objective, dealerId, cName, keep);
    const t = (totalsByCamp[campK] = totalsByCamp[campK] || { date, cName, campaignId: row.campaign_id || '', impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 });
    t.impr += rowImpr; t.reach += parseInt(row.reach) || 0; t.clicks += parseInt(row.clicks) || 0; t.cost += rowSpend; t.convs += convs;
  }

  const adData = await dailyPages((f, t) => base + 'level=ad&fields=campaign_id,campaign_name,adset_name,ad_name,impressions,reach,clicks,spend,actions,conversions&time_range=' +
    range(f, t) + '&time_increment=1' + unifiedParam + '&limit=1000&access_token=' + token, startDate, endDate, 'дневные объявления');
  tick();
  for (const rowA of adData) {
    const date = rowA.date_start; const cName = rowA.campaign_name || ''; const asName = rowA.adset_name || ''; const adName = rowA.ad_name || '';
    const aCId = rowA.campaign_id || cName;
    const wf = pickModelFieldWaterfall(cName, asName, adName, dealerId, dicts);
    const finalName = wf.field === 'camp' ? cName : wf.field === 'ag' ? cName + '_' + asName : wf.field === 'ad' ? cName + '_' + adName : cName + '_another';
    const campKey = date + '|||' + aCId;
    const fKey = date + '|||' + aCId + '|||' + finalName;
    const impr = parseInt(rowA.impressions) || 0; const reach = parseInt(rowA.reach) || 0; const clicks = parseInt(rowA.clicks) || 0; const cost = parseFloat(rowA.spend) || 0;
    const a = (aggregatedData[fKey] = aggregatedData[fKey] || { date, name: finalName, origCName: cName, impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 });
    a.impr += impr; a.reach += reach; a.clicks += clicks; a.cost += cost;
    const b = (allocatedByCamp[campKey] = allocatedByCamp[campKey] || { impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 });
    b.impr += impr; b.reach += reach; b.clicks += clicks; b.cost += cost;
    const shares = (modelSharesByCamp[campKey] = modelSharesByCamp[campKey] || {});
    const s = (shares[fKey] = shares[fKey] || { name: finalName, impr: 0, clicks: 0, cost: 0 });
    s.impr += impr; s.clicks += clicks; s.cost += cost;
  }

  // Месячный эталон — тот же unifiedParam, что у дневных запросов
  const monthlyData = await mainPages(base + 'level=campaign&fields=campaign_id,campaign_name,objective,actions,conversions&time_range=' +
    timeRange + unifiedParam + '&limit=1000&access_token=' + token, 'месячный эталон');
  tick();
  try {
    const trueMonthlyConvs = {}; const idToName = {};
    for (const mRow of monthlyData) {
      const mcName = mRow.campaign_name || '';
      const mcId = mRow.campaign_id || mcName;
      idToName[mcId] = mcName;
      if (!trueMonthlyConvs[mcId]) trueMonthlyConvs[mcId] = 0;
      trueMonthlyConvs[mcId] += Math.round(getMetaConversionFromRow(mRow, mRow.objective || '', dealerId, mcName, keep));
    }

    // Правила Hub (MHR), затем «Лиды» (MLO) — одни и те же строки ad set и цели ad set
    const adsetUrl = GRAPH + MHR_API_VERSION + '/act_' + accountId + '/insights?level=adset' +
      '&fields=campaign_id,campaign_name,adset_id,adset_name,objective,optimization_goal,impressions,actions,conversions,results' +
      '&use_unified_attribution_setting=true&time_range=' + timeRange + '&limit=500&access_token=' + encodeURIComponent(token);
    let goals = null;
    const adsetGoals = async () => {
      if (goals) return goals;
      goals = {};
      const r = await hubPages(GRAPH + MHR_API_VERSION + '/act_' + accountId + '/adsets?fields=id,optimization_goal,destination_type,' +
        'promoted_object{custom_event_type,custom_conversion_id}&limit=200&access_token=' + encodeURIComponent(token));
      if (r.error) warn(`⚠️ MHR act_${accountId} /adsets: ${r.error}`); // как в оригинале: цели ad set не обязательны
      for (const a of r.rows || []) {
        const po = a.promoted_object || {};
        goals[a.id] = { goal: String(a.optimization_goal || '').toUpperCase(), event: String(po.custom_event_type || '').toUpperCase(), customConvId: po.custom_conversion_id || '' };
      }
      return goals;
    };

    const g = await adsetGoals();
    const hub = await hubPages(adsetUrl);
    if (hub.error) {
      warn(`❌ MHR [${dealerId}] act_${accountId}: insights level=adset: ${hub.error} — эталон оставлен по прежним правилам ETL`);
    } else {
      const byId = {};
      for (const row of hub.rows) {
        const name = String(row.campaign_name || '').trim();
        if (!name) continue;
        const id = row.campaign_id || name;
        (byId[id] = byId[id] || { name, conv: 0 }).conv += mhrResultFor(row, g[row.adset_id] || {}).value;
      }
      for (const id of Object.keys(trueMonthlyConvs)) if (!Object.prototype.hasOwnProperty.call(byId, id)) trueMonthlyConvs[id] = 0;
      for (const id of Object.keys(byId)) {
        const v = Math.round(byId[id].conv);
        trueMonthlyConvs[id] = v;
        if (!idToName[id]) idToName[id] = byId[id].name;
        if (v > 0) registerKeep(keep, dealerId, byId[id].name);
      }
    }

    if (MLO_ACCOUNTS.includes(accountId)) {
      const r = hub.error ? await hubPages(adsetUrl) : hub;
      if (r.error) {
        warn(`❌ MLO [${dealerId}] act_${accountId}: insights level=adset: ${r.error} — эталон оставлен прежним`);
      } else {
        const byId = {};
        for (const row of r.rows) {
          const name = String(row.campaign_name || '').trim();
          if (!name) continue;
          const id = String(row.campaign_id || name);
          const c = (byId[id] = byId[id] || { name, conv: 0, touched: false });
          const goal = String((g[row.adset_id] && g[row.adset_id].goal) || row.optimization_goal || '').toUpperCase();
          const ind = (row.results || []).filter((it) => it && it.indicator).map((it) => String(it.indicator).replace(/^actions:/, ''));
          if (mloIsQualified(goal, ind)) { c.conv += mloLeads(row.actions); c.touched = true; } else c.conv += Number(mhrResultFor(row, g[row.adset_id] || {}).value) || 0;
        }
        for (const id of Object.keys(byId)) {
          const c = byId[id];
          if (!c.touched) continue;
          const v = Math.round(c.conv);
          trueMonthlyConvs[id] = v;
          if (!idToName[id]) idToName[id] = c.name;
          if (v > 0) registerKeep(keep, dealerId, c.name);
        }
      }
    }
    tick();

    const dailySums = {};
    for (const tk of Object.keys(totalsByCamp)) {
      const t = totalsByCamp[tk];
      const tId = t.campaignId || t.cName;
      dailySums[tId] = (dailySums[tId] || 0) + t.convs;
    }
    // Двусторонняя подгонка дневных значений под эталон: недостача — пропорционально показам, перебор — пропорциональное уменьшение
    for (const cId of Object.keys(trueMonthlyConvs)) {
      const etalon = trueMonthlyConvs[cId];
      const daily = dailySums[cId] || 0;
      const keys = Object.keys(totalsByCamp).filter((k) => (totalsByCamp[k].campaignId || totalsByCamp[k].cName) === cId).sort();
      if (etalon > daily) {
        if (keys.length === 0) continue; // кампания целиком вне окна — не приклеиваем к чужому дню (как в оригинале)
        // недостача — по дням пропорционально показам (если показов нет — на последний день)
        const imprW = keys.map((k) => totalsByCamp[k].impr);
        const add = imprW.some((w) => w > 0) ? splitIntByWeights(Math.round(etalon - daily), imprW) : keys.map((_, i) => (i === keys.length - 1 ? Math.round(etalon - daily) : 0));
        keys.forEach((k, i) => { totalsByCamp[k].convs += add[i]; });
      } else if (etalon < daily && daily > 0) {
        // перебор — уменьшаем дни пропорционально их конверсиям, сумма строго = эталон.
        // Раньше: Math.floor по дням + весь остаток на последний день → дни с 1–2 конверсиями обнулялись, а вчера получал 20+ чужих.
        const nv = splitIntByWeights(etalon, keys.map((k) => totalsByCamp[k].convs));
        keys.forEach((k, i) => { totalsByCamp[k].convs = nv[i]; });
      }
    }
  } catch (err) {
    warn(`⚠️ Ошибка сверки Meta [${dealerId}] act_${accountId}: ${err.message}`); // как в оригинале: дневные значения без подгонки
  }

  // Остаток кампании (не покрытый объявлениями) — под именем кампании; конверсии кампании — по моделям пропорционально показам
  for (const k of Object.keys(totalsByCamp)) {
    const t = totalsByCamp[k];
    const alloc = allocatedByCamp[k] || { impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 };
    const rImpr = Math.max(0, t.impr - alloc.impr); const rCost = Math.max(0, t.cost - alloc.cost); const rConvs = Math.max(0, t.convs - alloc.convs);
    const remKey = t.date + '|||' + (t.campaignId || t.cName) + '|||' + t.cName;
    const rem = () => (aggregatedData[remKey] = aggregatedData[remKey] || { date: t.date, name: t.cName, origCName: t.cName, impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 });
    if (rImpr > 0 || rCost > 0) {
      const r = rem();
      r.impr += rImpr; r.reach += Math.max(0, t.reach - alloc.reach); r.clicks += Math.max(0, t.clicks - alloc.clicks); r.cost += rCost;
    }
    if (rConvs > 0) {
      const shares = modelSharesByCamp[k];
      const shareKeys = shares ? Object.keys(shares) : [];
      if (shareKeys.length === 0) {
        rem().convs += rConvs;
      } else {
        let tImpr = 0; let tClicks = 0; let tCost = 0;
        for (const sk of shareKeys) { tImpr += shares[sk].impr; tClicks += shares[sk].clicks; tCost += shares[sk].cost; }
        const weightOf = (s) => (tImpr > 0 ? s.impr : tClicks > 0 ? s.clicks : tCost > 0 ? s.cost : 1);
        let totalWeight = 0;
        for (const sk of shareKeys) totalWeight += weightOf(shares[sk]);
        let distributed = 0; let maxWeight = -1; let biggestKey = shareKeys[0];
        for (const fk of shareKeys) {
          const w = weightOf(shares[fk]);
          if (w > maxWeight) { maxWeight = w; biggestKey = fk; }
          const portion = totalWeight > 0 ? Math.floor(rConvs * (w / totalWeight)) : 0;
          (aggregatedData[fk] = aggregatedData[fk] || { date: t.date, name: shares[fk].name, origCName: t.cName, impr: 0, reach: 0, clicks: 0, cost: 0, convs: 0 }).convs += portion;
          distributed += portion;
        }
        const leftover = rConvs - distributed;
        if (leftover > 0) aggregatedData[biggestKey].convs += leftover;
      }
    }
  }

  const rows = [];
  for (const key of Object.keys(aggregatedData)) {
    const agg = aggregatedData[key];
    const parsed = parseCampaignName(agg.name, dealerId, dicts);
    let goal = detectMarketingObjective(agg.name, campObjectives[agg.origCName || agg.name]);
    if (goal === 'Another') goal = parsed.objective;
    rows.push({
      Date: agg.date, Platform: 'Meta', Dealer_ID: dealerId, Dealer_Type: dealerId.includes('Distributor') ? 'Дистрибьютор' : 'Дилер',
      Campaign_Name: agg.name, Impressions: agg.impr, Reach: agg.reach, Clicks: agg.clicks, Conversions: Math.round(agg.convs),
      // Spend_KZT пересчитает applyRates по курсу из D1 (натив = Spend_USD, сумма API в валюте кабинета)
      Spend_KZT: agg.cost * 450, Spend_USD: agg.cost, Marketing_Objective: goal, Campaign_Type: parsed.type,
      Car_Brand: parsed.brand, Car_Model: parsed.model
    });
  }
  return rows;
}
