// Портал подключения дилеров (этап 5): общие правила для Worker autoreport-portal и задания «Портал: запись в таблицу».
// Перенос 1:1 правил самостоятельной регистрации из Auth_selfonboarding.gs (soClassifyDealerId_, soCommit, soAccountOwner_,
// soWriteRegistry_) и записи токена из Code.gs (saveTokenToSheet). Чистые функции + шифрование (Web Crypto: Worker и Node 20+).

export const PLATFORMS = ['Meta', 'Yandex', 'TikTok', 'Google'];
export const ID_COLUMNS = { Meta: 'Meta_Ad_Account_ID', Yandex: 'Yandex_Client_Login', TikTok: 'TikTok_Advertiser_ID', Google: 'Google_Customer_ID' };
export const REGISTRY_TABS = { Meta: 'Meta Ads', Google: 'Google Ads', TikTok: 'TikTok Ads', Yandex: 'Yandex Direct' };
export const ACCOUNT_PREFIX = { Meta: 'act_', Google: '', TikTok: '', Yandex: '' };
export const MULTI_PLATFORMS = ['Meta', 'Google', 'TikTok']; // Яндекс — один кабинет (ETL не разворачивает несколько)
export const RESERVED_PREFIXES = ['Distributor_', 'distributor_', 'DISTRIBUTOR_'];
export const DEALER_ID_RE = /^[A-Za-z0-9_-]{3,60}$/;
export const YANDEX_LOGIN_RE = /^[A-Za-z0-9._\-@]{2,80}$/;
export const MAX_PER_PLATFORM = 6;
export const MAX_PER_COMMIT = 8;
export const STAGED_TTL_MS = 24 * 3600 * 1000;
export const FIRST_ETL_START = '2026-01-01'; // как runAllPlatformsETL (ETL_Gateway.gs: START = '2026-01-01')
export const GH_PLATFORMS = { TikTok: 'tiktok', Yandex: 'yandex' }; // уже выгружаются в GitHub Actions

const str = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(0) : String(v).trim());

/** Название аккаунта (как soClassifyDealerId_). taken — Dealer_ID уже есть (без учёта регистра). */
export function classifyDealerId(raw, existingIds = []) {
  const id = str(raw);
  if (!id) return { status: 'bad_format', message: 'Укажите название аккаунта.' };
  if (!DEALER_ID_RE.test(id)) {
    return { status: 'bad_format', message: 'Допустимы только латиница, цифры, «_» и «-», от 3 до 60 символов. Пример: Dealer_Chery_Almaty' };
  }
  const reserved = RESERVED_PREFIXES.find((p) => id.startsWith(p));
  if (reserved) return { status: 'reserved', message: `Префикс «${reserved}» зарезервирован. Заявка уйдёт на проверку администратору.` };
  const low = id.toLowerCase();
  const same = existingIds.find((x) => str(x).toLowerCase() === low);
  if (same) return { status: 'taken', existing: same, message: 'Такой аккаунт уже зарегистрирован. Заявка на присоединение уйдёт администратору на проверку.' };
  return { status: 'ok', message: 'Название свободно.' };
}

/** ID кабинета для сравнения: без act_, без дефисов, нижний регистр (soNormAccount_ / maNorm_). */
export function normAccount(platform, value) {
  let s = str(value).toLowerCase();
  const prefix = (ACCOUNT_PREFIX[platform] || '').toLowerCase();
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  return s.replace(/-/g, '');
}

/**
 * Кому уже принадлежит кабинет. owners — [{Dealer_ID, Platform, account_id}] (копия cc_dealers: ячейка Total + реестр)
 * и [{Dealer_ID, Platform, account_id}] из ещё не записанных заявок портала. Возвращает Dealer_ID или ''.
 */
export function accountOwner(platform, accountId, selfDealerId, owners) {
  const target = normAccount(platform, accountId);
  if (!target) return '';
  const self = str(selfDealerId).toLowerCase();
  for (const o of owners || []) {
    if (o.Platform !== platform || !o.account_id) continue;
    if (str(o.Dealer_ID).toLowerCase() === self) continue;
    if (String(o.account_id).split(/[,;\s]+/).some((p) => p && normAccount(platform, p) === target)) return str(o.Dealer_ID);
  }
  return '';
}

/**
 * Проверка выбора кабинетов (гейт soCommit): каждый кабинет обязан быть виден токену пользователя
 * (live: { platform: [{id, name}] }), Яндекс — подтверждён проверкой логина (yandexOk: { login: name }).
 * Возвращает { ok, chosen: { platform: [{id, name}] }, error? }.
 */
export function checkSelection(selection, live, { yandexOk = {}, owners = [], dealerId = '' } = {}) {
  const chosen = {};
  let total = 0;
  for (const p of PLATFORMS) {
    const raw = selection && selection[p];
    const vals = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(str).filter(Boolean);
    if (!vals.length) continue;
    if (!MULTI_PLATFORMS.includes(p) && vals.length > 1) return { ok: false, status: 'rejected', error: `Для ${p} можно привязать только один кабинет: выгрузка не умеет читать несколько.` };
    if (vals.length > MAX_PER_PLATFORM) return { ok: false, status: 'too_many', error: `Для ${p} можно отметить не более ${MAX_PER_PLATFORM} кабинетов.` };
    const seen = (live && live[p]) || [];
    chosen[p] = [];
    for (const v of [...new Set(vals)]) {
      let acc = seen.find((a) => String(a.id) === v);
      if (!acc && p === 'Yandex' && yandexOk[v]) acc = { id: v, name: yandexOk[v] };
      if (!acc) return { ok: false, status: 'rejected', error: `Кабинет ${v} (${p}) не виден вашему токену. Привязать можно только собственные кабинеты.` };
      const owner = accountOwner(p, v, dealerId, owners);
      if (owner) {
        return { ok: false, status: 'account_taken', owner, error: `Кабинет ${v} (${p}) уже зарегистрирован в системе. Если он действительно ваш — напишите администратору: автоматически привязать его нельзя, расход задвоился бы в отчётах.` };
      }
      chosen[p].push({ id: String(acc.id), name: String(acc.name || acc.id) });
      total++;
    }
  }
  if (!total) return { ok: false, status: 'nothing_selected', error: 'Отметьте хотя бы один кабинет.' };
  if (total > MAX_PER_COMMIT) return { ok: false, status: 'too_many', error: `За одну регистрацию можно привязать не более ${MAX_PER_COMMIT} кабинетов.` };
  return { ok: true, chosen, total };
}

/** Цели Яндекс.Метрики: только числа через запятую (adm_cleanGoals_). */
export function cleanGoals(v) {
  const parts = str(v).split(/[,;\s]+/).filter(Boolean);
  for (const p of parts) if (!/^\d{1,15}$/.test(p)) throw new Error(`Цель Метрики должна быть числом: «${p.slice(0, 40)}»`);
  return parts.join(', ');
}

/* ---------- запись в таблицу All_Tokens ---------- */

/** Номер колонки → буквы A1 (0 → A, 26 → AA). */
export function colLetter(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Значение для ячейки Sheets не должно начинаться с = + - @ (защита от формул). */
export function safeCell(v) {
  const s = str(v).replace(/[\r\n\t]/g, ' ');
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function appendList(cur, value) {
  const c = str(cur);
  if (!c) return value;
  return c.toLowerCase().split(/,\s*/).includes(value.toLowerCase()) ? c : c + ', ' + value;
}

/**
 * План записи одной заявки в лист Total (rows — лист целиком, строка 0 — заголовки).
 * req: { kind: 'register' | 'update', dealer, email, goals, chosen: {platform: [{id,name}]}, tokens: {platform: token} }.
 * register — новая строка (если дилер уже есть, ошибка); update — правка первой строки дилера.
 * Как soCommit: токен площадки, первый кабинет в ячейку ID, его название — в <P>_Search_Keyword, цели Яндекса, Email дописывается.
 * Остальные кабинеты — в реестр (planRegistry).
 * @returns {{ append: string[]|null, updates: {range: string, value: string}[], missing: string[], row: number }}
 */
export function planTotal(rows, req) {
  const head = (rows[0] || []).map(str);
  const idx = {};
  head.forEach((h, i) => { if (h && !(h in idx)) idx[h] = i; });
  if (!('Distr_Dealer_ID' in idx)) throw new Error('В листе Total нет колонки Distr_Dealer_ID');
  const low = str(req.dealer).toLowerCase();
  let rowNo = -1;
  for (let r = 1; r < rows.length; r++) if (str((rows[r] || [])[idx.Distr_Dealer_ID]).toLowerCase() === low) { rowNo = r; break; }
  if (req.kind === 'register' && rowNo !== -1) throw new Error(`Дилер ${req.dealer} уже есть в листе Total — регистрация не повторяется`);
  if (req.kind === 'update' && rowNo === -1) throw new Error(`Дилер ${req.dealer} не найден в листе Total`);

  const values = {};
  const missing = [];
  const set = (col, v) => { if (col in idx) values[col] = safeCell(v); else missing.push(col); };
  const cur = (col) => (rowNo === -1 || !(col in idx) ? '' : str((rows[rowNo] || [])[idx[col]]));
  // registry: какие ID площадки дописать в реестр MultiAccount_Universal (выгрузка объединяет ячейку Total и реестр).
  const registry = {};
  for (const p of PLATFORMS) {
    const list = (req.chosen && req.chosen[p]) || [];
    if (!list.length) continue;
    if (req.tokens && req.tokens[p]) set(p + '_Token', req.tokens[p]);
    const cellIds = cur(ID_COLUMNS[p]).split(/[,;\s]+/).filter(Boolean).map((x) => normAccount(p, x));
    if (MULTI_PLATFORMS.includes(p) && cellIds.length) {
      // Кабинеты ДОБАВЛЯЮТСЯ к уже подключённым: ячейка Total и название не трогаются, новые — в реестр.
      const add = list.filter((a) => !cellIds.includes(normAccount(p, a.id))).map((a) => a.id);
      if (add.length) registry[p] = add;
      continue;
    }
    set(ID_COLUMNS[p], list[0].id);
    set(p + '_Search_Keyword', list[0].name);
    if (list.length > 1) registry[p] = list.map((a) => a.id);
  }
  if (req.goals && req.chosen && req.chosen.Yandex && req.chosen.Yandex.length) set('Yandex_Goal_IDs', req.goals);
  if (req.email) set('Email', appendList(cur('Email'), str(req.email).toLowerCase()));

  if (rowNo === -1) {
    const width = Math.max(head.length, 1);
    const row = new Array(width).fill('');
    row[idx.Distr_Dealer_ID] = safeCell(req.dealer);
    for (const [col, v] of Object.entries(values)) row[idx[col]] = v;
    return { append: row, updates: [], missing, row: rows.length + 1, registry };
  }
  const sheetRow = rowNo + 1;
  return { append: null, missing, row: sheetRow, registry,
    updates: Object.entries(values).map(([col, v]) => ({ range: `'Total'!${colLetter(idx[col])}${sheetRow}`, value: v })) };
}

/**
 * Реестр MultiAccount_Universal (вкладка площадки): строка дилера с ID без префикса в колонках правее A,
 * кроме колонок с «token» в заголовке (soWriteRegistry_). Существующие ID дилера сохраняются, новые дописываются.
 * @returns {{ append: string[]|null, updates: {range, value}[], ids: string[] }}
 */
export function planRegistry(rows, tab, platform, dealer, accountIds) {
  const prefix = ACCOUNT_PREFIX[platform] || '';
  const clean = accountIds.map((v) => {
    let s = str(v);
    if (prefix && s.toLowerCase().startsWith(prefix)) s = s.slice(prefix.length);
    return s;
  }).filter(Boolean);
  const head = ((rows && rows[0]) || []).map((h) => str(h).toLowerCase());
  const isTok = (c) => (head[c] || '').includes('token');
  let rowNo = -1;
  for (let r = 1; r < (rows || []).length; r++) if (str((rows[r] || [])[0]) === dealer) { rowNo = r; break; }
  const existing = rowNo === -1 ? [] : (rows[rowNo] || []).slice(1).map((v, i) => (isTok(i + 1) ? '' : str(v))).filter(Boolean);
  const have = new Set(existing.flatMap((v) => v.split(/[,;\s]+/)).map((v) => normAccount(platform, v)));
  const add = clean.filter((v) => !have.has(normAccount(platform, v)));
  // свободные колонки после последней заполненной (не-token)
  const row = rowNo === -1 ? [] : rows[rowNo] || [];
  let col = 1;
  for (let c = 1; c < row.length; c++) if (!isTok(c) && str(row[c])) col = c + 1;
  const cells = [];
  for (const v of add) {
    while (isTok(col)) col++;
    cells.push({ col, value: safeCell(v) });
    col++;
  }
  const q = "'" + tab.replace(/'/g, "''") + "'";
  if (rowNo === -1) {
    const out = [safeCell(dealer)];
    for (const c of cells) { while (out.length < c.col) out.push(''); out[c.col] = c.value; }
    return { append: out, updates: [], ids: add };
  }
  return { append: null, ids: add, updates: cells.map((c) => ({ range: `${q}!${colLetter(c.col)}${rowNo + 1}`, value: c.value })) };
}

/* ---------- шифрование токенов (AES-GCM 256, ключ — base64url 32 байта) ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str_) {
  const s = String(str_).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function aesKey(keyB64) {
  const raw = unb64u(keyB64 || '');
  if (raw.length !== 32) throw new Error('Ключ шифрования портала (PORTAL_ENC_KEY) не задан или неверной длины');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Шифр: v1.<iv>.<данные>; aad — к чему привязан шифр (почта|площадка), чтобы его нельзя было переставить. */
export async function sealToken(keyB64, plain, aad = '') {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(keyB64), enc.encode(String(plain)));
  return 'v1.' + b64u(iv) + '.' + b64u(new Uint8Array(ct));
}

export async function openToken(keyB64, sealed, aad = '') {
  const [v, iv, ct] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Неверный формат шифра');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv), additionalData: enc.encode(aad) }, await aesKey(keyB64), unb64u(ct));
  return dec.decode(pt);
}

/** Отпечаток токена как thHash_ (первые 4 байта SHA-256, hex): по нему видно, что токен тот же, сам токен не раскрывается. */
export async function fingerprint(token) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(token))));
  return Array.from(h.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}
