// Проверка токенов площадок — перенос 1:1 из AUTH_Token_Health.gs (thCheckMeta_, thCheckGoogle_, thCheckTikTok_, thCheckYandex_).
// Выполняется в Worker портала (там лежат ключи приложений); задание GitHub «Проверка токенов» присылает токены из листа Total.
// status: OK | EXPIRING | INVALID | ERROR (не удалось проверить — сеть/API).

export const WARN_DAYS = 14;
const META_API = 'https://graph.facebook.com/v19.0';

function res(status, daysLeft, expiresAt, dataAccessExpiresAt, type, owner, details) {
  return { status, daysLeft, expiresAt: expiresAt || '', dataAccessExpiresAt: dataAccessExpiresAt || '', type: type || '', owner: owner || '', details: details || '' };
}

async function fetchJson(fetchImpl, url, opts = {}) {
  const r = await fetchImpl(url, opts);
  let json = null;
  try { json = await r.json(); } catch { json = null; }
  return { code: r.status, json };
}

function ts(unix) {
  const n = Number(unix || 0);
  if (!n) return '';
  return new Date(n * 1000 + 5 * 3600000).toISOString().slice(0, 10); // дата по Алматы
}

function metaErr(j) {
  if (!j) return '';
  if (j.error && j.error.message) return j.error.message;
  if (j.data && j.data.error && j.data.error.message) return j.data.error.message;
  return '';
}

export async function checkMeta(env, token, fetchImpl = fetch, now = Date.now()) {
  const appToken = env.META_CLIENT_ID + '|' + env.META_CLIENT_SECRET;
  const dbg = await fetchJson(fetchImpl, `${META_API}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`);
  const me = await fetchJson(fetchImpl, `${META_API}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
  const owner = me.json && me.json.name ? `${me.json.name} (${me.json.id})` : '';
  const d = dbg.json && dbg.json.data ? dbg.json.data : null;
  if (!d || (d.error && d.is_valid === undefined)) {
    if (owner) return res('OK', null, '', '', '', owner, 'срок не определён: ' + metaErr(dbg.json) + '; /me отвечает');
    return res(me.json && me.json.error ? 'INVALID' : 'ERROR', null, '', '', '', '', metaErr(me.json) || metaErr(dbg.json) || 'HTTP ' + me.code);
  }
  const exp = Number(d.expires_at || 0);
  const dax = Number(d.data_access_expires_at || 0);
  const appNote = d.app_id && String(d.app_id) !== String(env.META_CLIENT_ID) ? '; приложение ' + d.app_id : '';
  if (d.is_valid !== true) return res('INVALID', null, ts(exp), ts(dax), d.type, owner, ((d.error && d.error.message) || 'токен недействителен') + appNote);
  let nearest = 0;
  if (exp > 0) nearest = exp;
  if (dax > 0 && (nearest === 0 || dax < nearest)) nearest = dax;
  const daysLeft = nearest > 0 ? Math.floor((nearest * 1000 - now) / 86400000) : null;
  const status = daysLeft !== null && daysLeft <= WARN_DAYS ? 'EXPIRING' : 'OK';
  return res(status, daysLeft, ts(exp) || 'бессрочный', ts(dax), d.type, owner, 'scopes: ' + (d.scopes || []).join(',') + appNote);
}

export async function checkGoogle(env, refreshToken, fetchImpl = fetch) {
  const r = await fetchJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' })
  });
  if (r.json && r.json.access_token) return res('OK', null, 'refresh_token', '', 'refresh_token', '', 'обмен на access_token успешен');
  if (r.json && r.json.error) {
    const st = r.json.error === 'invalid_grant' || r.json.error === 'unauthorized_client' ? 'INVALID' : 'ERROR';
    return res(st, null, '', '', '', '', r.json.error + (r.json.error_description ? ': ' + r.json.error_description : ''));
  }
  return res('ERROR', null, '', '', '', '', 'HTTP ' + r.code);
}

export async function checkTikTok(env, token, fetchImpl = fetch) {
  const r = await fetchJson(fetchImpl, `https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?app_id=${encodeURIComponent(env.TIKTOK_APP_ID)}&secret=${encodeURIComponent(env.TIKTOK_SECRET)}`,
    { headers: { 'Access-Token': token } });
  if (r.json && r.json.code === 0) return res('OK', null, '', '', '', '', 'рекламодателей видно: ' + ((r.json.data && r.json.data.list) || []).length);
  if (r.json && typeof r.json.code === 'number') {
    const bad = (r.json.code >= 40100 && r.json.code <= 40105) || r.json.code === 40001;
    return res(bad ? 'INVALID' : 'ERROR', null, '', '', '', '', 'code ' + r.json.code + ': ' + (r.json.message || ''));
  }
  return res('ERROR', null, '', '', '', '', 'HTTP ' + r.code);
}

export async function checkYandex(env, token, fetchImpl = fetch) {
  const r = await fetchJson(fetchImpl, 'https://login.yandex.ru/info?format=json', { headers: { Authorization: 'OAuth ' + token } });
  if (r.json && r.json.login) return res('OK', null, '', '', '', r.json.login, '');
  if (r.code === 401) return res('INVALID', null, '', '', '', '', 'токен отозван или истёк (HTTP 401)');
  return res('ERROR', null, '', '', '', '', 'HTTP ' + r.code);
}

export async function checkToken(env, platform, token, fetchImpl = fetch) {
  try {
    if (platform === 'Meta') return await checkMeta(env, token, fetchImpl);
    if (platform === 'Google') return await checkGoogle(env, token, fetchImpl);
    if (platform === 'TikTok') return await checkTikTok(env, token, fetchImpl);
    if (platform === 'Yandex') return await checkYandex(env, token, fetchImpl);
  } catch (e) {
    return res('ERROR', null, '', '', '', '', 'исключение: ' + String((e && e.message) || e).slice(0, 200));
  }
  return res('ERROR', null, '', '', '', '', 'неизвестная площадка');
}

/** Строка листа Token_Health (как thWriteReport_): дата проверки ISO → таблица покажет её текстом. */
export const HEALTH_HEAD = ['Проверено', 'Dealer_ID', 'Платформа', 'Статус', 'Дней осталось', 'Токен истекает', 'Доступ к данным истекает', 'Тип', 'Владелец токена', 'Детали', 'Отпечаток токена'];

export function healthRow(checkedAt, dealer, platform, r, fp) {
  const days = r.daysLeft === null || r.daysLeft === undefined ? (r.expiresAt === 'бессрочный' ? 'бессрочно' : '') : r.daysLeft;
  return [checkedAt, dealer, platform, r.status, days, r.expiresAt, r.dataAccessExpiresAt, r.type, r.owner, r.details, fp];
}
