/**
 * 03_Meta.gs — выгрузка Meta Ads (несколько кабинетов на дилера).
 *
 * Registry: meta_act_ids   — "1404746167669355, 979486171834945" (можно с act_ или без)
 *           meta_token_key — имя свойства с токеном, если не общий META_TOKEN
 *
 * ================== ЧТО ИСПРАВЛЕНО ПРОТИВ ПРЕЖНЕЙ ВЕРСИИ ==================
 *
 * M1. НАЗВАНИЕ КАМПАНИИ.
 *     Было: (r.campaign_name || '').trim().replace('_conv', '')
 *     replace резал подстроку ИЗНУТРИ имени, поэтому
 *     meta_perf_mytravel_conversion → meta_perf_mytravelersion.
 *     Замена убрана. Если хвост "_conv" всё же надо срезать —
 *     META_STRIP_CONV_SUFFIX = true, тогда режется только В КОНЦЕ имени.
 *
 * M2. КОЛИЧЕСТВО КОНВЕРСИЙ.
 *     Было: для objective = OUTCOME_SALES всегда брался purchase → 8 вместо 87.
 *     Кабинет в колонке «Результат» показывает событие, под которое оптимизируется
 *     AD SET, а не покупку. У meta_perf_mytravel_conversion это «Начатые оформления
 *     заказа на сайте» = offsite_conversion.fb_pixel_initiate_checkout = 87.
 *
 *     Событие лежит в promoted_object.custom_event_type группы объявлений, а в
 *     /insights этого поля НЕТ. Поэтому теперь сначала запрашивается /adsets и
 *     строится карта adset_id → {optimization_goal, custom_event_type,
 *     custom_conversion_id}, и только потом считается результат:
 *
 *       1) custom_conversion_id → offsite_conversion.custom.<id>
 *       2) custom_event_type    → offsite_conversion.fb_pixel_<событие>
 *       3) optimization_goal    → переписки / лиды / клики / просмотры ЦС
 *       4) objective            → старая эвристика (страховка, если /adsets не ответил)
 *
 * M3. Добавлена диагностика metaDiagCampaign('BYD', 'часть_имени', '2026-09-01', '2026-09-23')
 *     — печатает в лог ВСЕ action_type с числами и то, что попадёт в лист.
 *
 * M4. Карта целей кэшируется на время запуска: при выгрузке нескольких месяцев
 *     подряд /adsets дёргается один раз на кабинет, а не на каждый период.
 *
 * M5. ГЛАВНОЕ: конверсии берутся из поля `results` Insights API — это ровно
 *     колонка «Результат» кабинета, Meta считает её сама по цели ad set.
 *     Раньше «Результат» восстанавливался из `actions`, но часть веб-событий
 *     (например «Начатые оформления заказа») Meta отдаёт только в поле
 *     `conversions` — поэтому было 10 вместо 91.
 *     Если `results` не пришёл — запасной путь: actions + conversions + цель ad set.
 *     Поле `results` есть в новых версиях API, поэтому версия поднимается
 *     минимум до META_MIN_API_VERSION, даже если в Config стоит v19.0.
 *
 * M6. НЕКОНВЕРСИОННЫЕ СТРАТЕГИИ (просмотры целевой страницы, клики, охват, показы,
 *     видео, вовлечённость) — их «Результат» конверсией НЕ считается.
 *     Вместо него берётся событие с сайта по правилу:
 *       1) «Начатые оформления заказа на сайте», если их больше 0;
 *       2) иначе — из «Завершённые регистрации», «Добавления платёжной информации»,
 *          «Покупки на сайте» то, где событий БОЛЬШЕ (при равенстве — в этом порядке);
 *       3) если ничего нет — 0.
 *     Пример: meta_awar_mytravel_traffic — было 2 596 (просмотры ЦС), станет 4
 *     (начатые оформления заказа).
 *     Переписки и лид-формы остаются конверсиями, как раньше.
 *
 * M7. Правила Mapping с аккаунтом (колонка C = act_id) применяются к кампаниям этого
 *     кабинета ДО сложения кабинетов по имени — одинаковые имена из разных кабинетов
 *     можно развести.
 * =========================================================================
 */

var META_STRIP_CONV_SUFFIX = false;   // true → отрезать "_conv" только в конце имени
var META_ADSET_CACHE_ = {};           // actId → {adset_id: {...}} на время запуска
var META_MIN_API_VERSION = 'v23.0';   // ниже этой версии поля results нет

// M6: «Результат» с такими индикаторами — НЕ конверсия (подстроки, нижний регистр)
var META_NON_CONV_INDICATORS = [
  'landing_page_view', 'link_click', 'outbound_click', 'reach', 'impressions',
  'video', 'thruplay', 'post_engagement', 'page_engagement', 'post_reaction',
  'like', 'profile_visit', 'ig_profile', 'instagram_profile', 'estimated_ad_recall'
];

// M6: цели оптимизации, которые НЕ являются конверсией
var META_NON_CONV_GOALS = {
  LANDING_PAGE_VIEWS: 1, LINK_CLICKS: 1, REACH: 1, IMPRESSIONS: 1, AD_RECALL_LIFT: 1,
  THRUPLAY: 1, TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: 1, POST_ENGAGEMENT: 1, PAGE_LIKES: 1,
  PROFILE_VISIT: 1, VISIT_INSTAGRAM_PROFILE: 1, EVENT_RESPONSES: 1
};

// M6: события сайта для неконверсионных кампаний
var META_SITE_CHECKOUT = ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout',
                          'omni_initiated_checkout', 'initiate_checkout_website'];
var META_SITE_OTHERS = [   // порядок = приоритет при равном количестве
  { name: 'Завершённые регистрации',       types: ['offsite_conversion.fb_pixel_complete_registration', 'complete_registration', 'omni_complete_registration', 'complete_registration_website'] },
  { name: 'Добавления платёжной информации', types: ['offsite_conversion.fb_pixel_add_payment_info', 'add_payment_info', 'omni_add_payment_info', 'add_payment_info_website'] },
  { name: 'Покупки на сайте',              types: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase', 'purchase_website'] }
];

/** Версия API: из Config, но не ниже META_MIN_API_VERSION. */
function metaApiVersion_() {
  var cfg = String(configValue('META_API_VERSION') || '').trim();
  var n = function (v) { var m = /v?(\d+)(?:\.(\d+))?/.exec(v); return m ? (+m[1]) * 100 + (+(m[2] || 0)) : 0; };
  return n(cfg) >= n(META_MIN_API_VERSION) ? cfg : META_MIN_API_VERSION;
}

// custom_event_type → action_type (по приоритету)
var META_EVENT_ACTIONS = {
  PURCHASE:              ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase'],
  INITIATED_CHECKOUT:    ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout', 'omni_initiated_checkout'],
  INITIATE_CHECKOUT:     ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout', 'omni_initiated_checkout'],
  ADD_TO_CART:           ['offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart', 'omni_add_to_cart'],
  ADD_PAYMENT_INFO:      ['offsite_conversion.fb_pixel_add_payment_info', 'add_payment_info', 'omni_add_payment_info'],
  ADD_TO_WISHLIST:       ['offsite_conversion.fb_pixel_add_to_wishlist', 'add_to_wishlist'],
  COMPLETE_REGISTRATION: ['offsite_conversion.fb_pixel_complete_registration', 'complete_registration', 'omni_complete_registration'],
  LEAD:                  ['offsite_conversion.fb_pixel_lead', 'lead', 'omni_lead'],
  CONTENT_VIEW:          ['offsite_conversion.fb_pixel_view_content', 'view_content', 'omni_view_content'],
  VIEW_CONTENT:          ['offsite_conversion.fb_pixel_view_content', 'view_content', 'omni_view_content'],
  SEARCH:                ['offsite_conversion.fb_pixel_search', 'search', 'omni_search'],
  SUBSCRIBE:             ['offsite_conversion.fb_pixel_subscribe', 'subscribe'],
  START_TRIAL:           ['offsite_conversion.fb_pixel_start_trial', 'start_trial'],
  DONATE:                ['offsite_conversion.fb_pixel_donate', 'donate'],
  CONTACT:               ['offsite_conversion.fb_pixel_contact', 'contact'],
  SCHEDULE:              ['offsite_conversion.fb_pixel_schedule', 'schedule'],
  SUBMIT_APPLICATION:    ['offsite_conversion.fb_pixel_submit_application', 'submit_application'],
  CUSTOMIZE_PRODUCT:     ['offsite_conversion.fb_pixel_customize_product'],
  FIND_LOCATION:         ['offsite_conversion.fb_pixel_find_location'],
  MESSAGING_CONVERSATION_STARTED_7D: ['onsite_conversion.messaging_conversation_started_7d'],
  MESSAGING_APPOINTMENT_CONFIRMED:   ['onsite_conversion.messaging_appointment_confirmed']
};

// optimization_goal → action_type, когда события пикселя нет
var META_GOAL_ACTIONS = {
  CONVERSATIONS:        ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'],
  REPLIES:              ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'],
  LEAD_GENERATION:      ['onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_lead'],
  QUALITY_LEAD:         ['onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_lead'],
  QUALITY_CALL:         ['onsite_conversion.lead_grouped', 'lead'],
  LANDING_PAGE_VIEWS:   ['landing_page_view'],
  LINK_CLICKS:          ['link_click'],
  POST_ENGAGEMENT:      ['post_engagement'],
  PAGE_LIKES:           ['like'],
  EVENT_RESPONSES:      ['rsvp'],
  APP_INSTALLS:         ['mobile_app_install', 'omni_app_install'],
  THRUPLAY:             ['video_view'],
  TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: ['video_view'],
  VALUE:                ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase'],
  OFFSITE_CONVERSIONS:  ['offsite_conversion.fb_pixel_purchase', 'purchase', 'offsite_conversion.fb_pixel_lead', 'lead']
  // REACH / IMPRESSIONS / AD_RECALL_LIFT → конверсий нет по определению, вернётся 0
};

// ---------------------------------------------------------------------------
// ТОЧКА ВХОДА (сигнатура прежняя — 06_Pipeline не меняется)
// ---------------------------------------------------------------------------
function fetchMeta(dealer, df, dt, disp) {
  var ids = splitIds(dealer.meta_act_ids);
  if (!ids.length) return null;
  var token = tokenFor(dealer, 'meta');

  var all = [];
  ids.forEach(function (act) {
    var actId = String(act).replace(/^act_/, '');
    var goals = metaAdsetGoals_(actId, token);             // M2 + M4
    metaInsights_(actId, token, df, dt).forEach(function (r) {
      r._goals = goals;                                    // цели того же кабинета
      r._act = actId;                                      // M7: для Mapping по аккаунту
      all.push(r);
    });
  });
  return processMetaRows_(all, disp);
}

// ---------------------------------------------------------------------------
// ШАГ 1 — КАРТА ЦЕЛЕЙ ПО AD SET
// ---------------------------------------------------------------------------
function metaAdsetGoals_(actId, token) {
  if (META_ADSET_CACHE_[actId]) return META_ADSET_CACHE_[actId];

  var map = {};
  var url = 'https://graph.facebook.com/' + metaApiVersion_() + '/act_' + actId +
    '/adsets?fields=id,optimization_goal,billing_event,destination_type,' +
    'promoted_object{custom_event_type,custom_event_str,custom_conversion_id,pixel_id,page_id}' +
    '&limit=200&access_token=' + encodeURIComponent(token);

  var page = 0;
  try {
    while (url && page < 30) {
      page++;
      var res = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
      if (res.error) {
        // не роняем выгрузку: без карты целей конверсии посчитаются по objective (менее точно)
        Logger.log('⚠️ Meta act_' + actId + ' /adsets: ' + JSON.stringify(res.error).substring(0, 300));
        break;
      }
      (res.data || []).forEach(function (a) {
        var po = a.promoted_object || {};
        map[a.id] = {
          goal:         String(a.optimization_goal || '').toUpperCase(),
          event:        String(po.custom_event_type || '').toUpperCase(),
          customConvId: po.custom_conversion_id || '',
          destination:  String(a.destination_type || '').toUpperCase()
        };
      });
      url = res.paging && res.paging.next ? res.paging.next : null;
    }
  } catch (e) {
    Logger.log('⚠️ Meta act_' + actId + ' /adsets исключение: ' + e.message);
  }

  Logger.log('Meta act_' + actId + ': целей ad set загружено ' + Object.keys(map).length);
  META_ADSET_CACHE_[actId] = map;
  return map;
}

// ---------------------------------------------------------------------------
// ШАГ 2 — INSIGHTS (добавлено поле adset_id)
// ---------------------------------------------------------------------------
function metaInsights_(actId, token, df, dt) {
  var url = 'https://graph.facebook.com/' + metaApiVersion_() + '/act_' + actId +
    '/insights?level=adset' +
    '&fields=campaign_name,adset_id,adset_name,objective,optimization_goal,' +
    'impressions,reach,clicks,spend,actions,conversions,results' +
    '&use_unified_attribution_setting=true' +
    '&time_range=' + encodeURIComponent('{"since":"' + df + '","until":"' + dt + '"}') +
    '&access_token=' + encodeURIComponent(token) + '&limit=500';

  var rows = [], next = url, page = 0;
  while (next && page < 30) {
    page++;
    var res = JSON.parse(UrlFetchApp.fetch(next, { muteHttpExceptions: true }).getContentText());
    if (res.error) throw new Error('Meta act_' + actId + ': ' + JSON.stringify(res.error).substring(0, 300));
    if (!res.data) break;
    rows = rows.concat(res.data);
    next = res.paging && res.paging.next ? res.paging.next : null;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ШАГ 3 — АГРЕГАЦИЯ ПО КАМПАНИЯМ
// ---------------------------------------------------------------------------
function processMetaRows_(rows, disp) {
  var agg = {};

  rows.forEach(function (r) {
    // M1: никакого replace('_conv','') внутри строки
    var camp = String(r.campaign_name || '').trim();
    if (META_STRIP_CONV_SUFFIX) camp = camp.replace(/_conv$/i, '');
    camp = mapCampaignForAccount(camp, r._act);            // M7
    if (!camp) return;

    var pick = metaResultFor_(r, (r._goals && r._goals[r.adset_id]) || {});
    var meta = (r._goals && r._goals[r.adset_id]) || {};

    Logger.log('   [' + camp + ' / ' + (r.adset_name || '?') + '] goal=' +
               (meta.goal || r.optimization_goal || '—') + ' event=' + (meta.event || '—') +
               ' → ' + pick.source + ' = ' + pick.value);

    if (!agg[camp]) agg[camp] = { impr: 0, reach: 0, clicks: 0, conv: 0, cost: 0 };
    agg[camp].impr   += parseInt(r.impressions) || 0;
    agg[camp].reach  += parseInt(r.reach) || 0;
    agg[camp].clicks += parseInt(r.clicks) || 0;
    agg[camp].conv   += pick.value;
    agg[camp].cost   += parseFloat(r.spend) || 0;
  });

  var out = [];
  Object.keys(agg).forEach(function (k) {
    var s = agg[k];
    if (!rowHasData(s.impr, s.clicks, s.conv, s.cost)) return;
    out.push([disp, k, s.impr, s.reach, s.clicks, Math.round(s.conv), s.cost]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// ВЫБОР «РЕЗУЛЬТАТА»
// ---------------------------------------------------------------------------

/**
 * Итог по строке ad set:
 *   неконверсионная стратегия (M6) → событие с сайта по правилу;
 *   иначе → поле results (= «Результат» кабинета);
 *   results не пришёл → запасной путь по цели ad set.
 */
function metaResultFor_(r, meta) {
  var acts = metaActionsMap_(r.actions, r.conversions);
  var goal = meta.goal || String(r.optimization_goal || '').toUpperCase();
  var fromResults = metaResultsValue_(r.results);

  var nonConv = META_NON_CONV_GOALS[goal] === 1 ||
                (fromResults && metaIsNonConvIndicator_(fromResults.indicators));
  if (nonConv) return metaSiteEvent_(acts, goal || (fromResults && fromResults.indicators.join(',')));

  if (fromResults) return fromResults;

  var pick = metaPickResult_(acts, {
    goal:         meta.goal || String(r.optimization_goal || '').toUpperCase(),
    event:        meta.event || '',
    customConvId: meta.customConvId || '',
    objective:    String(r.objective || '').toUpperCase()
  });
  return { value: pick.value, source: 'запасной путь: ' + pick.source };
}

/**
 * Поле results: [{indicator: 'actions:offsite_conversion.fb_pixel_initiate_checkout',
 *                 values: [{value: '91', attribution_windows: ['default']}]}]
 * null — если поле не пришло совсем (тогда работает запасной путь).
 */
function metaResultsValue_(results) {
  if (!results || !results.length) return null;
  var total = 0, found = false, names = [];
  results.forEach(function (it) {
    if (!it) return;
    names.push(String(it.indicator || '?').replace(/^actions:/, ''));
    var vals = it.values || [];
    if (!vals.length && it.value !== undefined) { total += parseFloat(it.value) || 0; found = true; return; }
    var pickV = null;
    vals.forEach(function (v) {
      var w = v.attribution_windows || [];
      if (!pickV && w.indexOf('default') > -1) pickV = v;
    });
    if (!pickV && vals.length) pickV = vals[0];
    if (pickV) { total += parseFloat(pickV.value) || 0; }
    found = true;                       // индикатор есть, значений нет → честный 0
  });
  return found ? { value: total, source: 'results: ' + names.join(', '), indicators: names } : null;
}

/** M6: «Результат» — просмотры/клики/охват и т.п.? */
function metaIsNonConvIndicator_(indicators) {
  if (!indicators || !indicators.length) return false;
  return indicators.every(function (ind) {
    var s = String(ind).toLowerCase();
    return META_NON_CONV_INDICATORS.some(function (w) { return s.indexOf(w) > -1; });
  });
}

/**
 * M6: событие с сайта для неконверсионной кампании.
 *   1) Начатые оформления заказа > 0 → они;
 *   2) иначе максимум из регистраций / платёжной информации / покупок;
 *   3) иначе 0.
 */
function metaSiteEvent_(acts, why) {
  var ic = metaPickAction_(acts, META_SITE_CHECKOUT);
  if (ic && ic.value > 0) {
    return { value: ic.value, source: 'стратегия ' + why + ' не конверсия → Начатые оформления заказа' };
  }
  var best = null;
  META_SITE_OTHERS.forEach(function (ev) {
    var p = metaPickAction_(acts, ev.types);
    if (p && p.value > 0 && (!best || p.value > best.value)) best = { value: p.value, name: ev.name };
  });
  if (best) return { value: best.value, source: 'стратегия ' + why + ' не конверсия → ' + best.name };
  return { value: 0, source: 'стратегия ' + why + ' не конверсия, событий с сайта нет → 0' };
}

/** actions[] + conversions[] → {action_type: значение} */
function metaActionsMap_(actions, conversions) {
  var m = {};
  [actions || [], conversions || []].forEach(function (list) {
    list.forEach(function (a) {
      var t = String(a.action_type || '').toLowerCase();
      var v = parseFloat(a.value) || 0;
      m[t] = Math.max(m[t] || 0, v);
    });
  });
  return m;
}

function metaPickAction_(acts, list) {
  var best = 0, found = null;
  for (var i = 0; i < list.length; i++) {
    var key = String(list[i]).toLowerCase();
    if (acts[key] !== undefined && acts[key] > best) { best = acts[key]; found = key; }
  }
  return found ? { value: best, source: found } : null;
}

/** {value, source} — то же число, что кабинет пишет в колонку «Результат». */
function metaPickResult_(acts, cfg) {
  if (cfg.customConvId) {
    var cc = metaPickAction_(acts, ['offsite_conversion.custom.' + cfg.customConvId]);
    if (cc) return cc;
  }
  if (cfg.event && META_EVENT_ACTIONS[cfg.event]) {
    var ev = metaPickAction_(acts, META_EVENT_ACTIONS[cfg.event]);
    return ev ? ev : { value: 0, source: cfg.event + ' (0 за период)' };
  }
  if (cfg.goal && META_GOAL_ACTIONS[cfg.goal]) {
    var g = metaPickAction_(acts, META_GOAL_ACTIONS[cfg.goal]);
    return g ? g : { value: 0, source: cfg.goal + ' (0 за период)' };
  }
  if (cfg.goal === 'REACH' || cfg.goal === 'IMPRESSIONS' || cfg.goal === 'AD_RECALL_LIFT') {
    return { value: 0, source: cfg.goal + ' (конверсий нет по определению)' };
  }

  // Страховка: /adsets не ответил — считаем по objective, как раньше
  var fallback;
  if (cfg.objective === 'OUTCOME_SALES' || cfg.objective === 'CONVERSIONS') {
    fallback = ['offsite_conversion.fb_pixel_purchase', 'purchase',
                'offsite_conversion.fb_pixel_initiate_checkout',
                'offsite_conversion.fb_pixel_lead', 'lead'];
  } else if (cfg.objective === 'OUTCOME_LEADS' || cfg.objective === 'LEAD_GENERATION') {
    fallback = ['onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_lead',
                'onsite_conversion.messaging_conversation_started_7d'];
  } else if (cfg.objective === 'OUTCOME_ENGAGEMENT' || cfg.objective === 'MESSAGES') {
    fallback = ['onsite_conversion.messaging_conversation_started_7d', 'post_engagement'];
  } else if (cfg.objective === 'OUTCOME_TRAFFIC' || cfg.objective === 'LINK_CLICKS') {
    fallback = ['landing_page_view', 'link_click'];
  } else {
    fallback = ['offsite_conversion.fb_pixel_purchase', 'lead',
                'onsite_conversion.messaging_conversation_started_7d', 'landing_page_view'];
  }
  var f = metaPickAction_(acts, fallback);
  return f ? { value: f.value, source: f.source + ' (по objective)' }
           : { value: 0, source: 'не определено' };
}

// ---------------------------------------------------------------------------
// ДИАГНОСТИКА — запускать при любом расхождении с кабинетом
// ---------------------------------------------------------------------------
/**
 * metaDiagCampaign('BYD', 'mytravel_conversion', '2026-09-01', '2026-09-23')
 * Печатает по каждой группе объявлений: цель, событие, все action_type с числами
 * и то, что попадёт в лист. Сверяй с кабинетом за ТОТ ЖЕ период.
 */
function metaDiagCampaign(dealerId, campaignPart, df, dt) {
  var dealer = findDealer(dealerId);
  if (!dealer) { Logger.log('Дилер не найден: ' + dealerId); return; }
  var token = tokenFor(dealer, 'meta');
  var needle = String(campaignPart || '').toLowerCase();
  var hit = 0;

  splitIds(dealer.meta_act_ids).forEach(function (act) {
    var actId = String(act).replace(/^act_/, '');
    var goals = metaAdsetGoals_(actId, token);
    metaInsights_(actId, token, df, dt).forEach(function (r) {
      if (String(r.campaign_name || '').toLowerCase().indexOf(needle) === -1) return;
      hit++;
      var meta = goals[r.adset_id] || {};
      var acts = metaActionsMap_(r.actions, r.conversions);
      var pick = metaResultFor_(r, meta);
      Logger.log('═══ act_' + actId + ' | ' + r.campaign_name + ' / ' + r.adset_name);
      Logger.log('objective=' + r.objective +
                 ' | optimization_goal=' + (meta.goal || r.optimization_goal) +
                 ' | custom_event_type=' + (meta.event || '—') +
                 ' | custom_conversion_id=' + (meta.customConvId || '—'));
      Logger.log('spend=' + r.spend + ' | impressions=' + r.impressions + ' | clicks=' + r.clicks);
      Logger.log('results (как в кабинете): ' + JSON.stringify(r.results || null));
      Logger.log('actions + conversions:');
      Object.keys(acts).sort().forEach(function (k) { Logger.log('   ' + k + ' = ' + acts[k]); });
      Logger.log('>>> В лист попадёт: ' + pick.value + ' (источник: ' + pick.source + ')');
    });
  });

  if (!hit) Logger.log('Кампаний с "' + campaignPart + '" за ' + df + ' — ' + dt + ' не найдено');
}

// ---------------------------------------------------------------------------
// ПРОВЕРКА ТОКЕНА (используется в 08_Menu, не менялась)
// ---------------------------------------------------------------------------
function metaSelfCheck_(token) {
  var v = metaApiVersion_();
  var dbg = JSON.parse(UrlFetchApp.fetch('https://graph.facebook.com/' + v + '/debug_token?input_token=' +
    encodeURIComponent(token) + '&access_token=' + encodeURIComponent(token), { muteHttpExceptions: true }).getContentText());
  if (dbg.error) throw new Error(JSON.stringify(dbg.error).substring(0, 200));
  var d = dbg.data || {};
  return 'валиден: ' + d.is_valid + ', истекает: ' + (d.expires_at === 0 ? 'никогда' : new Date(d.expires_at * 1000));
}