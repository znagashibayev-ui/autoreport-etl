// Кабинеты Haval/Tank (воркер fb-leads-haval) и Changan (fb-leads-changan, etl/changan_dealers.json) → отдельные дилеры в daily_statistics (Platform = 'Meta').
// Соответствие «кабинет → Dealer_ID» — в etl/haval_dealers.json (правится только после подтверждения владельцем).
// Защита от задвоения: кабинет, который уже грузит ночная выгрузка Meta (есть в cc_dealers.account_id), пропускается;
// Dealer_ID, у которого в cc_dealers прописан кабинет Meta, не используется вовсе — иначе DELETE снёс бы его ночные строки.

import fs from 'node:fs';
import path from 'node:path';

export const PLATFORM = 'Meta';
const ETL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/** '123' и 'act_123' — один кабинет. */
export const normAccount = (v) => String(v || '').trim().replace(/^act_/i, '');

/** brand: haval | changan. Список — секрет <BRAND>_DEALERS_JSON, если задан, иначе etl/<brand>_dealers.json. */
export function loadMap(brand = 'haval', file = decodeURIComponent(path.join(ETL_DIR, brand + '_dealers.json'))) {
  const envName = brand.toUpperCase() + '_DEALERS_JSON';
  const fileName = path.basename(file);
  if (!process.env[envName] && !fs.existsSync(file)) {
    throw new Error(`Нет списка кабинетов: задайте секрет ${envName} (GitHub → репозиторий autoreport-etl → Settings → Secrets and variables → Actions)`);
  }
  const text = process.env[envName] || fs.readFileSync(file, 'utf8');
  let raw;
  try { raw = JSON.parse(text); } catch { raw = null; }
  if (!raw || typeof raw !== 'object' || !raw.accounts || typeof raw.accounts !== 'object') {
    throw new Error(`Список кабинетов испорчен (секрет ${envName} или файл etl/${fileName}): в нём нет "accounts" (например, текст «[object Object]»). ` +
      `Если задан секрет: GitHub → репозиторий autoreport-etl → Settings → Secrets and variables → Actions → ${envName} → удалите его, тогда возьмётся файл.`);
  }
  const out = new Map();
  for (const [acc, v] of Object.entries(raw.accounts || {})) {
    const id = String(typeof v === 'string' ? v : v.dealer_id || '').trim();
    if (!id) continue;
    if (!/^[A-Za-z0-9_.\-]+$/.test(id)) throw new Error(`${fileName}: недопустимый Dealer_ID «${id}» (только латиница, цифры, _ . -)`);
    out.set(normAccount(acc), { dealerId: id, dealerType: (typeof v === 'object' && v.dealer_type) || 'Дилер' });
  }
  const ids = [...out.values()].map((x) => x.dealerId.toLowerCase());
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new Error(`${fileName}: Dealer_ID «${dup}» назначен двум кабинетам`);
  return out;
}

/**
 * Строки cc_dealers (Platform = 'Meta') → кабинеты, которые уже грузит ночная выгрузка, и дилеры с кабинетом Meta.
 * В account_id бывает список через запятую.
 */
export function nightlyMeta(ccRows) {
  const accounts = new Map();
  const dealers = new Set();
  for (const r of ccRows || []) {
    const ids = String(r.account_id || '').split(/[,\s;]+/).map(normAccount).filter(Boolean);
    if (!ids.length) continue;
    dealers.add(String(r.Dealer_ID).toLowerCase());
    for (const a of ids) accounts.set(a, r.Dealer_ID);
  }
  return { accounts, dealers };
}

/**
 * Разложить кабинеты выгрузки: какие пишутся дилерами, какие пропущены и почему.
 * @returns {{write: Map<string, {dealerId, dealerType}>, report: object[]}}
 */
export function plan(spendRows, map, nightly) {
  const accounts = new Map();
  for (const r of spendRows) {
    const a = normAccount(r.account_id);
    if (!accounts.has(a)) accounts.set(a, { account_id: a, account_name: r.account_name, dealership: r.dealership, mark: r.mark, spend: 0 });
    accounts.get(a).spend += r.spend;
    if (accounts.get(a).mark !== r.mark) accounts.get(a).mark = 'несколько марок'; // смешанный кабинет: строки по маркам
  }
  const write = new Map();
  const report = [];
  for (const a of accounts.values()) {
    const m = map.get(a.account_id);
    let status;
    if (nightly.accounts.has(a.account_id)) status = `пропущен: уже грузится ночной выгрузкой Meta как ${nightly.accounts.get(a.account_id)}`;
    else if (!m) status = 'нет в списке кабинетов (etl/<марка>_dealers.json) — в отчёт не пишется';
    else if (nightly.dealers.has(m.dealerId.toLowerCase())) status = `пропущен: у ${m.dealerId} уже есть свой кабинет Meta в All_Tokens`;
    else { status = '→ ' + m.dealerId; write.set(a.account_id, m); }
    report.push({ ...a, spend: Math.round(a.spend * 100) / 100, dealer_id: m ? m.dealerId : '', status });
  }
  report.sort((x, y) => String(x.dealership || '').localeCompare(String(y.dealership || '')) || String(x.account_name).localeCompare(String(y.account_name)));
  return { write, report };
}

/** Строки haval_spend → строки daily_statistics (одна на день × кабинет; кампаний и моделей в источнике нет). */
export function toDaily(spendRows, write, defaultBrand = null) {
  const out = [];
  for (const r of spendRows) {
    const m = write.get(normAccount(r.account_id));
    if (!m) continue;
    if (!r.spend && !r.impressions && !r.clicks && !r.meta_leads) continue;
    out.push({
      Date: r.date, Platform: PLATFORM, Dealer_ID: m.dealerId, Dealer_Type: m.dealerType,
      Campaign_Name: r.account_name || r.account_id,
      Impressions: r.impressions, Reach: null, Clicks: r.clicks, Conversions: r.meta_leads,
      Spend_KZT: null, Spend_USD: r.spend,                 // натив кабинета (USD); applyRates пересчитает по курсам сайта
      Marketing_Objective: null, Campaign_Type: null,
      Car_Brand: r.mark || defaultBrand, Car_Model: null // кабинет без марки в справочнике воркера → марка задания
    });
  }
  return out;
}
