// Чтение Google Таблиц (Sheets API v4) сервисным аккаунтом. Только чтение.
// Значения без форматирования, даты — серийными номерами (как getValues в Apps Script, без часовых поясов).

export const ALL_TOKENS_ID = '1Nf_yQ8mruUIpK06U9AsZ3fkqU7yV6BTPIqbA32XHnis';
export const ETL_SPREADSHEET_ID = '1_oRrS0T4FQYdIuLe-OMVcbyIp6EM-cC3ky_AT4wsuPo'; // AutoReport_ETL_Engine

/**
 * @param {string|(() => Promise<string>)} token
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @returns {Promise<unknown[][]>}
 */
export async function readSheet(token, spreadsheetId, sheetName, fetchImpl = fetch, waitMs = 20000) {
  const bearer = typeof token === 'function' ? await token() : token;
  const range = encodeURIComponent("'" + sheetName.replace(/'/g, "''") + "'");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}` +
    '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS';
  let res; let body;
  // лимит Google Sheets — 60 чтений в минуту: при 429 ждём 20, 40, 60 с и повторяем
  for (let attempt = 0; ; attempt++) {
    res = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + bearer } });
    body = await res.json().catch(() => ({}));
    if (res.status !== 429 || attempt >= 3) break;
    await new Promise((r) => setTimeout(r, waitMs * (attempt + 1)));
  }
  if (!res.ok) {
    const msg = (body.error && body.error.message) || 'HTTP ' + res.status;
    const hint = res.status === 403
      ? ' — откройте таблицу сервисному аккаунту autoreport-github@astana-motors-accounts.iam.gserviceaccount.com (Настройки доступа → Читатель) и включите Google Sheets API в проекте.'
      : '';
    throw new Error(`Таблица ${spreadsheetId}, лист «${sheetName}»: ${msg}${hint}`);
  }
  return body.values || [];
}
