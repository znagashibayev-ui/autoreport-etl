// Курсы валют — задаются владельцем на сайте (раздел «Курсы валют»), хранятся в D1. Курса Нацбанка больше нет.
//
//   fx_rates             курс USD→KZT и EUR→KZT за месяц на трёх уровнях, точный перекрывает общий:
//                        аккаунт (дилер × площадка) → площадка → вся сеть. Пустое поле = берётся с уровня выше.
//   fx_account_currency  валюта кабинета: строка дилера перекрывает строку площадки (Dealer_ID = '').
//
// Каждая строка daily_statistics хранит расход в валюте кабинета (Spend_Native, Currency), поэтому пересчёт
// при смене курса точный: Spend_KZT и Spend_USD всегда считаются из натива. Нет нужного курса — поле
// остаётся пустым (NULL), а месяц попадает в список ошибок: молча по «какому-то» курсу ничего не считается.
//
// Модуль без зависимостей от Node: его же использует Worker сайта.

export const PLATFORMS = ['Meta', 'Google Ads', 'TikTok', 'Yandex'];
export const CURRENCIES = ['KZT', 'USD', 'EUR'];

/** Договорные курсы из Apps Script (ExchangeRate.gs: FIXED_RATES_BY_MONTH) — ими посчитаны данные до октября 2026. */
export const LEGACY_FIXED_RATES = {
  '2026-01': { USD: 550, EUR: 600 },
  '2026-02': { USD: 550, EUR: 600 },
  '2026-03': { USD: 480, EUR: 600 },
  '2026-04': { USD: 466.5, EUR: 600 },
  '2026-05': { USD: 491, EUR: 564 },
  '2026-06': { USD: 482, EUR: 600 },
  '2026-07': { USD: 550, EUR: 600 },
  '2026-08': { USD: 463, EUR: 600 },
  '2026-09': { USD: 500, EUR: 600 }
};

/** Валюты кабинетов, которые были зашиты в Apps Script (ACCOUNT_CURRENCY_DEFAULT / _OVERRIDE). */
export const LEGACY_CURRENCY_DEFAULT = { 'Google Ads': 'USD', Meta: 'USD', TikTok: 'USD', Yandex: 'KZT' };
export const LEGACY_CURRENCY_OVERRIDE = { Distributor_BMW: { 'Google Ads': 'EUR' } };

export function legacyCurrency(dealerId, platform) {
  const o = LEGACY_CURRENCY_OVERRIDE[dealerId];
  if (o && o[platform]) return o[platform];
  return LEGACY_CURRENCY_DEFAULT[platform] || 'USD';
}

/**
 * Таблицы D1 → быстрый поиск.
 * @param {{rates?: object[], currencies?: object[]}} t  строки fx_rates и fx_account_currency
 */
export function buildFx(t) {
  const rates = new Map();
  for (const r of t.rates || []) rates.set(r.month + '|' + (r.Platform || '') + '|' + (r.Dealer_ID || ''), r);
  const currencies = new Map();
  for (const c of t.currencies || []) currencies.set((c.Platform || '') + '|' + (c.Dealer_ID || ''), c.currency);
  return { rates, currencies };
}

/** Валюта кабинета: дилер × площадка → площадка → USD. */
export function resolveCurrency(fx, dealerId, platform) {
  return fx.currencies.get(platform + '|' + dealerId) || fx.currencies.get(platform + '|') || 'USD';
}

function positive(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Курсы за месяц для аккаунта. Каждое поле ищется отдельно: аккаунт → площадка → сеть.
 * @returns {{usd: number|null, eur: number|null, usdFrom: string, eurFrom: string}}
 */
export function resolveRates(fx, month, dealerId, platform) {
  const levels = [['account', platform, dealerId], ['platform', platform, ''], ['network', '', '']];
  const out = { usd: null, eur: null, usdFrom: '', eurFrom: '' };
  for (const [name, p, d] of levels) {
    const r = fx.rates.get(month + '|' + p + '|' + d);
    if (!r) continue;
    if (out.usd === null && positive(r.usd) !== null) { out.usd = positive(r.usd); out.usdFrom = name; }
    if (out.eur === null && positive(r.eur) !== null) { out.eur = positive(r.eur); out.eurFrom = name; }
  }
  return out;
}

/**
 * Множители от натива: Spend_KZT = натив × kzt, Spend_USD = натив × usd. null — нет нужного курса.
 * @returns {{kzt: number|null, usd: number|null, need: string[]}}  need — каких курсов не хватает
 */
export function factors(currency, rates) {
  const need = [];
  if (currency === 'KZT') {
    if (rates.usd === null) need.push('USD');
    return { kzt: 1, usd: rates.usd === null ? null : 1 / rates.usd, need };
  }
  if (currency === 'EUR') {
    if (rates.eur === null) need.push('EUR');
    if (rates.usd === null) need.push('USD');
    return { kzt: rates.eur, usd: rates.eur !== null && rates.usd !== null ? rates.eur / rates.usd : null, need };
  }
  if (rates.usd === null) need.push('USD');
  return { kzt: rates.usd, usd: 1, need };
}

/** Натив строки, собранной ETL (как в Apps Script): KZT-кабинет — Spend_KZT, остальные — сумма API в Spend_USD. */
export function nativeOf(row, currency) {
  return currency === 'KZT' ? parseFloat(row.Spend_KZT) || 0 : parseFloat(row.Spend_USD) || 0;
}

/**
 * Пересчёт свежих строк ETL перед записью. Меняет строки на месте; вызывать один раз на пакет.
 * @returns {{touched: number, missing: {month: string, Dealer_ID: string, Platform: string, need: string[]}[]}}
 */
export function applyRates(rows, fx) {
  const missing = new Map();
  let touched = 0;
  for (const row of rows || []) {
    if (!row) continue;
    const dealer = (row.Dealer_ID || '').toString().trim();
    const platform = (row.Platform || '').toString();
    const month = (row.Date || '').toString().slice(0, 7);
    if (month.length < 7) continue;
    const currency = resolveCurrency(fx, dealer, platform);
    const native = nativeOf(row, currency);
    const f = factors(currency, resolveRates(fx, month, dealer, platform));
    row.Currency = currency;
    row.Spend_Native = native;
    row.Spend_KZT = f.kzt === null ? null : native * f.kzt;
    row.Spend_USD = f.usd === null ? null : native * f.usd;
    if (f.need.length) {
      const key = month + '|' + dealer + '|' + platform;
      if (!missing.has(key)) missing.set(key, { month, Dealer_ID: dealer, Platform: platform, need: f.need });
    }
    touched++;
  }
  return { touched, missing: [...missing.values()] };
}

/**
 * SQL-выражение «натив» для строк, где Spend_Native ещё пуст (перенесены из BigQuery до появления колонки).
 * Обращает пересчёт Apps Script: KZT — Spend_KZT; EUR в месяцах с договорным курсом — Spend_USD × USD/EUR;
 * иначе — Spend_USD (сумма API в валюте кабинета).
 */
export function legacyNativeSql(dealerId, platform, month) {
  const cur = legacyCurrency(dealerId, platform);
  if (cur === 'KZT') return 'Spend_KZT';
  const r = LEGACY_FIXED_RATES[month];
  if (cur !== 'USD' && r && r[cur] > 0) return `(Spend_USD * ${r.USD} / ${r[cur]})`;
  return 'Spend_USD';
}

/** Строки-пустышки (все метрики 0) не пишутся — как bqStripEmptyRows_ (BQW_STRIP_EMPTY_ROWS = true). */
export function stripEmptyRows(rows) {
  return rows.filter((r) => !(
    (Number(r.Impressions) || 0) === 0 && (Number(r.Reach) || 0) === 0 && (Number(r.Clicks) || 0) === 0 &&
    (Number(r.Conversions) || 0) === 0 && (Number(r.Spend_KZT) || 0) === 0 && (Number(r.Spend_USD) || 0) === 0 &&
    (Number(r.Spend_Native) || 0) === 0));
}
