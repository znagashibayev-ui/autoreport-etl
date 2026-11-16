// Сопоставление Dealer_ID из разных таблиц: медиаплан (Registry Autoreport Hub), лист Total (All_Tokens), D1, портал.
// Правило всей системы (как hcBqDaily_ / hcDaily в Apps Script и недолёты на сайте): Dealer_ID сравнивается БЕЗ учёта регистра.
// В Registry Hub ID часто записаны иначе, чем в Total («Dealer_BYD_Citystore» и «Dealer_BYD_CityStore») — это один дилер.
// Разные разделители («al_farabi» и «al-farabi») автоматически НЕ склеиваются: это показывается как подсказка «похожий ID».

/** Ключ сравнения: без пробелов по краям и без учёта регистра. */
export const idKey = (id) => String(id ?? '').trim().toLowerCase();

/** Ключ для подсказки: ещё и без пробелов, «_», «-» и точек. */
export const looseKey = (id) => idKey(id).replace(/[\s_.\-]+/g, '');

/**
 * Запрошенные ID (кнопка «Восстановить», портал, задание) → ID листа Total.
 * @param {string[]} requested  ID из запроса
 * @param {string[]} known      ID, которые можно выгрузить (из листа Total)
 * @returns {{matched: Set<string>, renamed: {asked: string, used: string[]}[], missing: string[]}}
 *   matched — ID листа Total для выгрузки; renamed — запрос записан иначе, чем в Total; missing — не найдены вовсе.
 */
export function resolveDealerIds(requested, known) {
  const byKey = new Map();
  for (const k of known) {
    const key = idKey(k);
    if (!key) continue;
    const list = byKey.get(key) || byKey.set(key, []).get(key);
    if (!list.includes(k)) list.push(k);
  }
  const matched = new Set(); const renamed = []; const missing = [];
  for (const id of requested) {
    const hit = byKey.get(idKey(id));
    if (!hit) { missing.push(id); continue; }
    for (const h of hit) matched.add(h);
    if (hit.some((h) => h !== String(id).trim())) renamed.push({ asked: id, used: hit });
  }
  return { matched, renamed, missing };
}

/** ID из known, которые отличаются от id только регистром и разделителями (для подсказки в ошибке). */
export function similarIds(id, known) {
  const l = looseKey(id);
  if (!l) return [];
  return [...new Set(known.filter((k) => looseKey(k) === l && idKey(k) !== idKey(id)))];
}

/**
 * Проверка Registry Hub против листа Total (для отчёта недолётов): какие ID медиапланов
 * записаны иначе (только регистр — работает, но лучше выровнять) и каких нет вовсе.
 * @returns {{caseOnly: {hub: string, total: string[]}[], absent: {hub: string, like: string[]}[]}}
 */
export function auditRegistryIds(hubIds, totalIds) {
  const caseOnly = []; const absent = [];
  for (const id of hubIds) {
    const same = totalIds.filter((t) => idKey(t) === idKey(id));
    if (same.includes(String(id).trim())) continue;
    if (same.length) caseOnly.push({ hub: id, total: [...new Set(same)] });
    else absent.push({ hub: id, like: similarIds(id, totalIds) });
  }
  return { caseOnly, absent };
}
