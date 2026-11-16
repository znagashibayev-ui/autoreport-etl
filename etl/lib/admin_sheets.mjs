// Разбор листов таблицы All_Tokens для админки (Total, Email_Access, Token_Health, Access_Log, Onboarding_Audit).
// Чистые функции: на вход — строки листа (readSheet, значения без форматирования), на выход — строки таблиц D1.
// Логика — как в Admin.gs проекта AUTH (adm_getOverview, adm_healthMap_, adm_getLogs).

export const PLATFORMS = ['Meta', 'Yandex', 'TikTok', 'Google'];
const COLS = {
  Meta: { token: 'Meta_Token', id: 'Meta_Ad_Account_ID', kw: 'Meta_Search_Keyword' },
  Yandex: { token: 'Yandex_Token', id: 'Yandex_Client_Login', kw: 'Yandex_Search_Keyword' },
  TikTok: { token: 'TikTok_Token', id: 'TikTok_Advertiser_ID', kw: 'TikTok_Search_Keyword' },
  Google: { token: 'Google_Token', id: 'Google_Customer_ID', kw: 'Google_Search_Keyword' }
};
export const LOG_LIMIT = 2000;
const SHEET_TZ_OFFSET_MIN = 5 * 60; // таблица и скрипт — Азия/Алматы (UTC+5)

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function headerIndex(row) {
  const idx = {};
  (row || []).forEach((h, i) => { idx[str(h)] = i; });
  return idx;
}

function cell(row, idx, name) {
  return name in idx ? str(row[idx[name]]) : '';
}

/** Дата из таблицы → ISO UTC: серийный номер (дни с 30.12.1899, время Алматы) или «дд.мм.гггг чч:мм[:сс]». */
export function sheetDate(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = Math.round((v - 25569) * 86400000) - SHEET_TZ_OFFSET_MIN * 60000;
    return new Date(ms).toISOString();
  }
  const m = str(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const ms = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) - SHEET_TZ_OFFSET_MIN * 60000;
    return new Date(ms).toISOString();
  }
  const d = new Date(str(v));
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Token_Health → карта «dealer_lower|Platform» → состояние. */
export function parseHealth(rows) {
  const map = {};
  if (!rows || rows.length < 2) return map;
  const idx = headerIndex(rows[0]);
  for (const r of rows.slice(1)) {
    const d = cell(r, idx, 'Dealer_ID').toLowerCase();
    const p = cell(r, idx, 'Платформа');
    if (!d || !p) continue;
    const checked = 'Проверено' in idx ? r[idx['Проверено']] : '';
    map[d + '|' + p] = {
      status: cell(r, idx, 'Статус'), days: cell(r, idx, 'Дней осталось'),
      expires: cell(r, idx, 'Токен истекает'), checked: checked === '' ? '' : sheetDate(checked) || str(checked)
    };
  }
  return map;
}

/**
 * Лист Total (+ здоровье токенов, + кабинеты из реестра MultiAccount_Universal) → строки cc_dealers.
 * Несколько строк одного дилера объединяются. registries: { Meta: parseRegistry(...), TikTok: ..., ... } из etl/lib/multiaccount.mjs.
 */
export function parseDealers(totalRows, health = {}, registries = {}) {
  if (!totalRows || totalRows.length < 1) throw new Error('Лист Total пуст');
  const idx = headerIndex(totalRows[0]);
  if (!('Distr_Dealer_ID' in idx)) throw new Error('В листе Total нет колонки Distr_Dealer_ID');
  const byKey = new Map();
  for (const r of totalRows.slice(1)) {
    const id = cell(r, idx, 'Distr_Dealer_ID');
    if (!id) continue;
    for (const p of PLATFORMS) {
      const key = id.toLowerCase() + '|' + p;
      const prev = byKey.get(key);
      const c = COLS[p];
      const h = health[key] || {};
      const row = {
        Dealer_ID: prev ? prev.Dealer_ID : id, Platform: p,
        Dealer_Type: (prev && prev.Dealer_Type) || cell(r, idx, 'Dealer_Type'),
        has_token: (prev && prev.has_token) || cell(r, idx, c.token) ? 1 : 0,
        account_id: [prev && prev.account_id, cell(r, idx, c.id)].filter(Boolean).join(', '),
        keyword: (prev && prev.keyword) || cell(r, idx, c.kw),
        goals: (prev && prev.goals) || cell(r, idx, 'Yandex_Goal_IDs'),
        health_status: h.status || null, health_days: h.days || null, health_expires: h.expires || null, health_checked: h.checked || null
      };
      byKey.set(key, row);
    }
  }
  for (const p of PLATFORMS) {
    const reg = registries[p] || {};
    for (const regDealer of Object.keys(reg)) {
      const row = byKey.get(regDealer.toLowerCase() + '|' + p);
      if (!row) continue; // в реестре, но нет строки в Total — выгрузка такого дилера не видит
      const have = row.account_id ? row.account_id.split(/,\s*/) : [];
      const norm = (x) => String(x).replace(/^act_/i, '').toLowerCase();
      for (const acc of reg[regDealer].accounts) if (!have.some((h) => norm(h) === norm(acc))) have.push(acc);
      row.account_id = have.join(', ');
      if (reg[regDealer].token) row.has_token = 1;
    }
  }
  return [...byKey.values()].sort((a, b) => (a.Dealer_ID + a.Platform).localeCompare(b.Dealer_ID + b.Platform));
}

/** Почта как в Access_guard.gs (ag_normEmail): без регистра, кавычек, угловых скобок и mailto:. */
export function normEmail(raw) {
  let s = str(raw).toLowerCase();
  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    s = s.replace(/^[<"'\s]+|[>"'\s]+$/g, '').replace(/^mailto:\s*/, '');
    if (s === before) break;
  }
  return s;
}

/** Формат почты как в ag_isValidFormat (кавычки и ; запрещены). */
export function validEmail(email) {
  return !!email && !/["'\\;`]/.test(email) && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email);
}

/** Почты одной ячейки B (несколько — через запятую, точку с запятой или с новой строки). */
export function cellEmails(raw) {
  return String(raw === null || raw === undefined ? '' : raw).split(/[,;\n]+/).map(normEmail).filter(Boolean);
}

/**
 * Лист Email_Access (A — дилер, B — одна или несколько почт) → пары «дилер × почта» без дублей,
 * ровно как ag_readPairs в Access_guard.gs (то же уходит в dealer_email_access). Почты с ошибкой формата — в bad.
 */
export function parseEmailAccess(rows) {
  const seen = new Set();
  const out = [];
  const bad = [];
  (rows || []).slice(1).forEach((r, i) => {
    const d = str(r[0]);
    if (!d) return;
    for (const e of cellEmails(r[1])) {
      if (!validEmail(e)) { bad.push('строка ' + (i + 2) + ': ' + e); continue; }
      if (seen.has(d + '|' + e)) continue;
      seen.add(d + '|' + e);
      out.push({ Dealer_ID: d, Email: e });
    }
  });
  out.bad = bad;
  return out;
}

/**
 * Правки доступа из админки → изменения листа Email_Access.
 * remove: почта убирается из ячеек B всех строк этого дилера (пустая ячейка остаётся — строка не удаляется);
 * add: новая строка «дилер, почта», если такой пары ещё нет. rows — лист целиком (строка 1 — заголовок).
 * @returns {{ updates: {row: number, value: string}[], appends: string[][], results: {id: number, status: string, note: string}[] }}
 */
export function planAccessEdits(rows, changes) {
  const cells = (rows || []).map((r) => ({ dealer: str(r[0]), emails: cellEmails(r[1]), raw: r[1] }));
  const touched = new Set();
  const appends = [];
  const results = [];
  const has = (dealer, email) => cells.some((c, i) => i > 0 && c.dealer.toLowerCase() === dealer.toLowerCase() && c.emails.includes(email)) ||
    appends.some((a) => a[0].toLowerCase() === dealer.toLowerCase() && a[1] === email);
  for (const ch of changes) {
    const email = normEmail(ch.email);
    const dealer = str(ch.dealer);
    if (ch.action === 'remove') {
      let n = 0;
      cells.forEach((c, i) => {
        if (i === 0 || c.dealer.toLowerCase() !== dealer.toLowerCase() || !c.emails.includes(email)) return;
        c.emails = c.emails.filter((e) => e !== email);
        touched.add(i);
        n++;
      });
      for (let k = appends.length - 1; k >= 0; k--) {
        if (appends[k][0].toLowerCase() === dealer.toLowerCase() && appends[k][1] === email) { appends.splice(k, 1); n++; }
      }
      results.push({ id: ch.id, status: 'done', note: n ? 'убрано' : 'в таблице уже не было' });
    } else {
      if (has(dealer, email)) results.push({ id: ch.id, status: 'done', note: 'в таблице уже было' });
      else { appends.push([dealer, email]); results.push({ id: ch.id, status: 'done', note: 'добавлено' }); }
    }
  }
  const updates = [...touched].sort((a, b) => a - b).map((i) => ({ row: i + 1, value: cells[i].emails.join(', ') }));
  return { updates, appends, results };
}

/** Access_Log (7 колонок) + Onboarding_Audit (6 колонок) → последние LOG_LIMIT записей, новые сверху. */
export function parseLogs(accessRows, onboardingRows, limit = LOG_LIMIT) {
  const out = [];
  for (const r of (accessRows || []).slice(1)) {
    const at = sheetDate(r[0]);
    if (!at) continue;
    out.push({ at, app: str(r[1]), event: str(r[2]), email: str(r[3]), dealer: str(r[4]), platform: str(r[5]), detail: str(r[6]).slice(0, 500) });
  }
  for (const r of (onboardingRows || []).slice(1)) {
    const at = sheetDate(r[0]);
    if (!at) continue;
    out.push({ at, app: 'Portal (onboarding)', event: str(r[1]), email: str(r[2]), dealer: str(r[3]), platform: str(r[4]), detail: str(r[5]).slice(0, 500) });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, limit);
}
