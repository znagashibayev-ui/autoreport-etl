// Несколько кабинетов у одного дилера — перенос 1:1 из Apps Script maExpand_ / maRegistry_ (MultiAccount_Universal.gs,
// версия 15.09.2026): ID кабинетов из ячейки листа Total + из таблицы-реестра (вкладки «Meta Ads», «Google Ads»,
// «TikTok Ads»), без дублей. Каждый кабинет — отдельная строка с тем же Dealer_ID.

export const MA_REGISTRY_ID = '1GQLATxt8pMMfmm5SQRXevA2-JIoWbYtH32gHKi41V3c';
export const MA_TABS = { Meta: 'Meta Ads', Google: 'Google Ads', TikTok: 'TikTok Ads', Yandex: 'Yandex Direct' };
const PREFIX = { Meta: 'act_', Google: '', TikTok: '', Yandex: '' };
const SPLIT = /[,;\s]+/;

function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toFixed(0);
  return v.toString().trim();
}
const notEmpty = (s) => s !== '';
function norm(v, prefix) {
  let s = str(v).toLowerCase();
  if (prefix) s = s.replace(new RegExp('^' + prefix, 'i'), '');
  return s.replace(/-/g, '');
}
function push(list, seen, raw, prefix) {
  let clean = str(raw);
  if (prefix) clean = clean.replace(new RegExp('^' + prefix, 'i'), '');
  if (!clean) return;
  const key = norm(clean, '');
  if (seen[key]) return;
  seen[key] = true;
  list.push(clean);
}

/** Вкладка реестра → { Dealer_ID: { accounts: [], token } } (maRegistry_). */
export function parseRegistry(values, platform) {
  const result = {};
  if (!values || values.length < 2) return result;
  const headers = values[0].map((h) => (h ? h.toString().trim().toLowerCase() : ''));
  const prefix = PREFIX[platform] || '';
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const dealerId = str(row[0]);
    if (!dealerId) continue;
    const e = (result[dealerId] = result[dealerId] || { accounts: [], token: '', seen: {} });
    for (let c = 1; c < row.length; c++) {
      const val = str(row[c]);
      if (!val) continue;
      if (headers[c] && headers[c].indexOf('token') > -1) { if (!e.token) e.token = val; continue; }
      for (const p of val.split(SPLIT).filter(notEmpty)) push(e.accounts, e.seen, p, prefix);
    }
  }
  for (const k of Object.keys(result)) if (!result[k].accounts.length) delete result[k];
  return result;
}

/** Строки листа Total → строки «по кабинету» (maExpand_). values[0] — заголовки. */
export function expandAccounts(values, accColName, tokColName, platform, registry = {}) {
  if (!values || values.length < 2) return values;
  const headers = values[0];
  const prefix = PREFIX[platform] || '';
  let colAcc = -1; let colTok = -1;
  headers.forEach((h, i) => {
    const nm = h ? h.toString().trim() : '';
    if (nm === accColName) colAcc = i;
    if (tokColName && nm === tokColName) colTok = i;
  });
  if (colAcc === -1) return values;
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const dealerId = str(row[0]);
    const cellStr = str(row[colAcc]);
    const cellAccounts = cellStr ? cellStr.split(SPLIT).filter(notEmpty) : [];
    const regEntry = dealerId && registry[dealerId] ? registry[dealerId] : null;
    const regAccounts = regEntry ? regEntry.accounts : [];
    const merged = []; const seen = {};
    for (const a of cellAccounts) push(merged, seen, a, prefix);
    for (const b of regAccounts) push(merged, seen, b, prefix);
    if (merged.length <= 1) { out.push(row); continue; }
    const tokStr = colTok === -1 ? '' : str(row[colTok]);
    const baseTokens = tokStr ? tokStr.split(SPLIT).filter(notEmpty) : [];
    const defTok = baseTokens.length ? baseTokens[0] : '';
    const tokMap = {};
    if (baseTokens.length > 1 && baseTokens.length === cellAccounts.length) {
      cellAccounts.forEach((a, t) => { tokMap[norm(a, prefix)] = baseTokens[t]; });
    }
    if (regEntry && regEntry.token) for (const a of regAccounts) tokMap[norm(a, prefix)] = regEntry.token;
    for (const m of merged) {
      const clone = row.slice();
      clone[colAcc] = prefix + m;
      if (colTok !== -1) clone[colTok] = tokMap[norm(m, prefix)] || defTok;
      out.push(clone);
    }
  }
  return out;
}
