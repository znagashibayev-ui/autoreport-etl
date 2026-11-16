// Доступ к Google API сервисным аккаунтом без сторонних библиотек: JWT (RS256) → токен,
// и чтение BigQuery «надёжным путём»: jobs.insert → ждать DONE → проверить errorResult →
// читать все страницы getQueryResults и сверить число строк с totalRows.

import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BQ = 'https://bigquery.googleapis.com/bigquery/v2';
// jobs.insert не принимает scope bigquery.readonly. Только чтение обеспечивают роли аккаунта
// (BigQuery Data Viewer + Job User — изменить таблицы с ними нельзя) и проверка SELECT в bqSelect.
export const BQ_SCOPE = 'https://www.googleapis.com/auth/bigquery';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
/** Для выгрузок: BigQuery (сверка) + чтение таблиц (токены, словари, курсы). */
export const ETL_SCOPES = ['https://www.googleapis.com/auth/bigquery', SHEETS_SCOPE];

/** Ключ сервисного аккаунта из JSON-строки (секрет GCP_SA_KEY). */
export function parseServiceAccount(json) {
  let key;
  try {
    key = JSON.parse(json);
  } catch {
    throw new Error('GCP_SA_KEY — не JSON. Вставьте в секрет содержимое скачанного .json-файла целиком.');
  }
  if (key.type !== 'service_account' || !key.client_email || !key.private_key) {
    throw new Error('GCP_SA_KEY — это не ключ сервисного аккаунта (нет client_email / private_key).');
  }
  return key;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Подписанный JWT для обмена на токен доступа. */
export function makeJwt(sa, scopes, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: scopes.join(' '), aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600
  }));
  const sig = crypto.createSign('RSA-SHA256').update(header + '.' + claims).sign(sa.private_key);
  return header + '.' + claims + '.' + b64url(sig);
}

export async function getAccessToken(sa, scopes, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: makeJwt(sa, scopes) })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error('Google не выдал токен: ' + (body.error_description || body.error || 'HTTP ' + res.status));
  }
  return body.access_token;
}

/**
 * Вход без ключа (Workload Identity Federation): GitHub Actions выдаёт свой OIDC-токен,
 * Google STS меняет его на федеративный, тот — на токен сервисного аккаунта на 1 час.
 * Нужен, когда политика организации запрещает создавать JSON-ключи.
 * @param {{provider: string, serviceAccount: string, scopes: string[], env?: object, fetchImpl?: typeof fetch}} o
 *   provider — projects/<номер>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
 */
/**
 * Приводит значение переменной GCP_WIF_PROVIDER к виду projects/…/providers/…:
 * убирает пробелы, переводы строк, кавычки и префиксы https://iam.googleapis.com/ и //iam.googleapis.com/.
 * Значение не секретное — в ошибке показывается целиком, чтобы было видно, что вставилось.
 */
export function normalizeWifProvider(raw) {
  const v = String(raw || '').replace(/[\s"'`]/g, '')
    .replace(/^(https:)?\/\/iam\.googleapis\.com\//, '');
  const m = /projects\/\d+\/locations\/global\/workloadIdentityPools\/[\w-]+\/providers\/[\w-]+/.exec(v);
  if (!m) {
    throw new Error('GCP_WIF_PROVIDER должен быть вида projects/<номер>/locations/global/workloadIdentityPools/<pool>/providers/<provider>. ' +
      'Сейчас в переменной: «' + String(raw || '').slice(0, 200) + '»');
  }
  return m[0];
}

export async function getAccessTokenViaWif({ provider: rawProvider, serviceAccount, scopes, env = process.env, fetchImpl = fetch }) {
  const provider = normalizeWifProvider(rawProvider);
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('Вход без ключа работает только в GitHub Actions с permissions: id-token: write');
  }
  const audience = 'https://iam.googleapis.com/' + provider;
  const oidcRes = await fetchImpl(env.ACTIONS_ID_TOKEN_REQUEST_URL + '&audience=' + encodeURIComponent(audience), {
    headers: { Authorization: 'bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }
  });
  const oidc = await oidcRes.json().catch(() => ({}));
  if (!oidcRes.ok || !oidc.value) throw new Error('GitHub не выдал OIDC-токен (HTTP ' + oidcRes.status + ')');

  const stsRes = await fetchImpl('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: '//iam.googleapis.com/' + provider,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectToken: oidc.value,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt'
    })
  });
  const sts = await stsRes.json().catch(() => ({}));
  if (!stsRes.ok || !sts.access_token) {
    throw new Error('Google STS отказал: ' + (sts.error_description || sts.error || 'HTTP ' + stsRes.status) +
      '. Проверьте пул, провайдер и условие на репозиторий.');
  }

  const genRes = await fetchImpl(
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + encodeURIComponent(serviceAccount) + ':generateAccessToken', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sts.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: scopes, lifetime: '3600s' })
    });
  const gen = await genRes.json().catch(() => ({}));
  if (!genRes.ok || !gen.accessToken) {
    throw new Error('Не удалось получить токен сервисного аккаунта: ' + ((gen.error && gen.error.message) || 'HTTP ' + genRes.status) +
      '. Нужна роль «Workload Identity User» для репозитория на этом сервисном аккаунте.');
  }
  return gen.accessToken;
}

/**
 * Источник токена с автообновлением каждые 50 минут: ключ (GCP_SA_KEY) или вход без ключа (GCP_WIF_PROVIDER).
 * @returns {() => Promise<string>}
 */
export function tokenProvider(scopes, env = process.env, fetchImpl = fetch) {
  let cached = '';
  let at = 0;
  return async function () {
    if (cached && Date.now() - at < 50 * 60000) return cached;
    if (env.GCP_SA_KEY) {
      cached = await getAccessToken(parseServiceAccount(env.GCP_SA_KEY), scopes, fetchImpl);
    } else if (env.GCP_WIF_PROVIDER) {
      cached = await getAccessTokenViaWif({ provider: env.GCP_WIF_PROVIDER, serviceAccount: env.GCP_SERVICE_ACCOUNT, scopes, env, fetchImpl });
    } else {
      throw new Error('Нет доступа к Google: задайте переменную GCP_WIF_PROVIDER (вход без ключа) или секрет GCP_SA_KEY.');
    }
    at = Date.now();
    return cached;
  };
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/** Запрос к Google API: повтор до 4 раз при сбое сети или 429/5xx (паузы 2, 4, 8 с). */
async function call(token, url, init = {}, fetchImpl = fetch) {
  let res;
  for (let attempt = 0; ; attempt++) {
    const bearer = typeof token === 'function' ? await token() : token;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json', ...(init.headers || {}) }
      });
    } catch (err) {
      if (attempt >= 3) throw new Error('Нет связи с Google API: ' + err.message);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= 3) break;
    await sleep(2000 * 2 ** attempt);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('BigQuery ответил не JSON (HTTP ' + res.status + '): ' + text.slice(0, 200));
  }
  if (!res.ok) {
    const msg = body.error ? body.error.message : 'HTTP ' + res.status;
    throw new Error('BigQuery: ' + msg);
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * SELECT в BigQuery целиком в память. Только для небольших результатов (агрегаты, один месяц daily).
 * Возвращает { schema: [{name, type}], rows: [объекты], bytes }.
 */
export async function bqSelect(token, opts) {
  const rows = [];
  const out = await bqStream(token, opts, (chunk) => { for (const r of chunk) rows.push(r); });
  return { schema: out.schema, rows, bytes: out.bytes };
}

/**
 * SELECT в BigQuery постранично: onRows(массив строк одной страницы, schema) вызывается на каждую
 * страницу, в памяти держится только текущая страница. Для больших выборок (разрезы).
 * token — строка или функция, возвращающая свежий токен (долгие выгрузки переживают смену токена).
 * Разрешён только SELECT / WITH — программа переноса BigQuery не меняет.
 * @returns {Promise<{schema: {name: string, type: string}[], total: number, bytes: number}>}
 */
export async function bqStream(token, { project, location, sql, maxWaitMs = 600000, pageSize = 20000, fetchImpl = fetch }, onRows) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Разрешены только SELECT-запросы.');
  const job = await call(token, `${BQ}/projects/${project}/jobs`, {
    method: 'POST',
    body: JSON.stringify({ configuration: { query: { query: sql, useLegacySql: false } }, jobReference: { location } })
  }, fetchImpl);
  const jobId = job.jobReference.jobId;
  const started = Date.now();
  let state = job;
  while (!state.status || state.status.state !== 'DONE') {
    if (Date.now() - started > maxWaitMs) throw new Error('BigQuery не завершил запрос за ' + maxWaitMs / 1000 + ' с (job ' + jobId + ')');
    await sleep(1500);
    state = await call(token, `${BQ}/projects/${project}/jobs/${jobId}?location=${location}`, {}, fetchImpl);
  }
  if (state.status.errorResult) throw new Error('BigQuery: ' + state.status.errorResult.message);

  let count = 0;
  let schema = null;
  let total = null;
  let pageToken = '';
  for (let guard = 0; guard < 100000; guard++) {
    const qs = new URLSearchParams({ location, maxResults: String(pageSize) });
    if (pageToken) qs.set('pageToken', pageToken);
    const page = await call(token, `${BQ}/projects/${project}/queries/${jobId}?${qs}`, {}, fetchImpl);
    if (!page.jobComplete) {
      if (Date.now() - started > maxWaitMs) throw new Error('BigQuery не отдал результат за ' + maxWaitMs / 1000 + ' с (job ' + jobId + ')');
      await sleep(1000);
      continue;
    }
    if (!schema) {
      schema = page.schema.fields.map((f) => ({ name: f.name, type: f.type }));
      total = Number(page.totalRows || 0);
    }
    const chunk = (page.rows || []).map((r) => rowToObject(schema, r));
    count += chunk.length;
    if (chunk.length) await onRows(chunk, schema);
    if (!page.pageToken) break;
    pageToken = page.pageToken;
  }
  if (total !== null && count !== total) {
    throw new Error(`BigQuery вернул ${count} строк из ${total} — запрос прочитан не полностью`);
  }
  const bytes = Number((state.statistics && state.statistics.totalBytesProcessed) || 0);
  return { schema: schema || [], total: count, bytes };
}

const NUMERIC = new Set(['INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC']);

/** Строка ответа BigQuery ({f: [{v}]}) → объект с числами там, где поле числовое. */
export function rowToObject(schema, r) {
  const o = {};
  schema.forEach((f, i) => {
    const v = r.f[i] ? r.f[i].v : null;
    if (v === null || v === undefined) o[f.name] = null;
    else if (NUMERIC.has(f.type)) o[f.name] = Number(v);
    else if (f.type === 'BOOLEAN' || f.type === 'BOOL') o[f.name] = v === 'true';
    else o[f.name] = String(v);
  });
  return o;
}

/** Список таблиц датасета с размером и числом строк (metadata, без сканирования данных). */
export async function bqListTables(token, { project, dataset, fetchImpl = fetch }) {
  const out = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({ maxResults: '1000' });
    if (pageToken) qs.set('pageToken', pageToken);
    const page = await call(token, `${BQ}/projects/${project}/datasets/${dataset}/tables?${qs}`, {}, fetchImpl);
    for (const t of page.tables || []) {
      const meta = await call(token, `${BQ}/projects/${project}/datasets/${dataset}/tables/${t.tableReference.tableId}`, {}, fetchImpl);
      out.push({
        table: t.tableReference.tableId,
        type: meta.type,
        rows: Number(meta.numRows || 0),
        bytes: Number(meta.numBytes || 0),
        partitioned: meta.timePartitioning ? meta.timePartitioning.field || '_PARTITIONTIME' : '',
        expires: meta.expirationTime ? new Date(Number(meta.expirationTime)).toISOString() : '',
        columns: (meta.schema && meta.schema.fields || []).map((f) => f.name + ':' + f.type)
      });
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return out;
}
