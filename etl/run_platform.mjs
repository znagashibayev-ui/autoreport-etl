#!/usr/bin/env node
// Ночная выгрузка площадки в D1 (замена Apps Script) + сверка с BigQuery, пока обе системы работают параллельно.
//
// Параметры (переменные окружения или --ключ значение):
//   PLATFORM  — yandex | tiktok | meta | google
//   START/END — период 'YYYY-MM-DD'. По умолчанию — как ночной ре-синк Apps Script с Gaps_Guard:
//               с 1-го числа месяца вчерашнего дня по вчера (часовой пояс скрипта Asia/Qyzylorda).
//   DEALERS   — только эти Dealer_ID через запятую (пусто = все, у кого есть токен и логин)
//   NO_WRITE  — 1 = только собрать и сверить: daily_statistics не трогается, итог и сверка пишутся в etl_runs / migration_check
//
// Доступ: GCP_WIF_PROVIDER + GCP_SERVICE_ACCOUNT (или GCP_SA_KEY) — таблицы и BigQuery;
//         CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID — запись в D1.
// Курсы валют — из D1 (fx_rates, fx_account_currency; задаются на сайте). Месяц без курса — ошибка запуска:
// строки пишутся, но пересчитанная сумма остаётся пустой, пока владелец не задаст курс и не нажмёт «Пересчитать».

import fs from 'node:fs';
import { ETL_SCOPES, bqSelect, tokenProvider } from './lib/google.mjs';
import { ALL_TOKENS_ID, ETL_SPREADSHEET_ID, readSheet } from './lib/sheets.mjs';
import { buildDictionaries } from './lib/classify.mjs';
import { applyRates, buildFx, stripEmptyRows } from './lib/fx.mjs';
import { buildInserts, sqlLiteral } from './lib/sql.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { compareAggregates } from './lib/compare.mjs';
import { chunkDates, parseGoals, yandexDealerRows } from './platforms/yandex.mjs';
import { chunkDates30, tiktokDealerRows } from './platforms/tiktok.mjs';
import { metaDealerRows } from './platforms/meta.mjs';
import { HUB_ID, googleDealerRows, monthsOf, parseHubOverrides, parseHubRegistry } from './platforms/googleads.mjs';
import { d1HttpRun, makeProgress } from './lib/progress.mjs';
import { MA_REGISTRY_ID, MA_TABS, expandAccounts, parseRegistry } from './lib/multiaccount.mjs';
import { awarenessZeroOut } from './lib/zeroout.mjs';
import { applyHubCap, parseAdsRegistry, parseMapping } from './lib/hubcap.mjs';
import { DAILY_COLUMNS } from './migrate_bq.mjs';
import { idKey, resolveDealerIds, similarIds } from './lib/dealer_ids.mjs';
import { cabinetRecords } from './lib/gaps.mjs';

const SCRIPT_TZ = 'Asia/Qyzylorda';
const QUOTA_PAUSE_MS = Number(process.env.QUOTA_PAUSE_MS || 90000);

/** Ошибка лимита запросов площадки — лечится паузой, а не исправлением токена. */
export function isQuotaError(msg) {
  return /Resource has been exhausted|RESOURCE_EXHAUSTED|rate limit|too many requests|HTTP 429/i.test(String(msg || ''));
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[name.toUpperCase()] || fallback;
}

/** Вчера и окно «с 1-го числа» в часовом поясе скрипта. */
export function defaultWindow(now = new Date()) {
  const y = new Intl.DateTimeFormat('en-CA', { timeZone: SCRIPT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now.getTime() - 86400000));
  return { start: y.slice(0, 8) + '01', end: y };
}

const PLATFORMS = {
  yandex: {
    name: 'Yandex',
    halfLabel: 'токен / логин',
    native: 'Spend_KZT', cur: '₸', // кабинеты Яндекса в тенге
    units: (s, e) => 2 * chunkDates(s, e).length, // кусков отчёта на дилера — для процента в админке
    /** Дилеры из листа Total, у которых заполнены и токен, и логин. Строки одного Dealer_ID объединяются. */
    dealers(values) {
      const h = values[0] || [];
      const cTok = h.indexOf('Yandex_Token');
      const cLogin = h.indexOf('Yandex_Client_Login');
      const cGoals = h.indexOf('Yandex_Goal_IDs');
      if (cTok === -1 || cLogin === -1) throw new Error('В листе Total нет колонок Yandex_Token / Yandex_Client_Login');
      const out = [];
      const halfFilled = [];
      for (let i = 1; i < values.length; i++) {
        const r = values[i] || [];
        const dealerId = r[0] ? r[0].toString().trim() : '';
        const token = r[cTok] ? r[cTok].toString().trim() : '';
        const login = r[cLogin] ? r[cLogin].toString().trim() : '';
        if (!dealerId) continue;
        if (!token || !login) { if (token || login) halfFilled.push(dealerId); continue; }
        out.push({ dealerId, token, login, goals: parseGoals(cGoals > -1 ? r[cGoals] : '') });
      }
      return { list: out, halfFilled };
    },
    rows: (d, ctx) => yandexDealerRows({ ...d, ...ctx })
  },
  tiktok: {
    name: 'TikTok',
    halfLabel: 'TikTok_Token / TikTok_Advertiser_ID',
    native: 'Spend_USD', cur: '$', // Apps Script пишет сумму API в Spend_USD
    units: (s, e) => 2 * chunkDates30(s, e).length,
    registryTab: MA_TABS.TikTok,
    dealers: (values, registry) => accountDealers(values, registry, 'TikTok_Advertiser_ID', 'TikTok_Token', 'TikTok', 'advId'),
    rows: (d, ctx) => tiktokDealerRows({ ...d, ...ctx })
  },
  meta: {
    name: 'Meta',
    halfLabel: 'Meta_Token / Meta_Ad_Account_ID',
    native: 'Spend_USD', cur: '$', // Apps Script пишет сумму API (валюта кабинета) в Spend_USD
    units: (s, e) => 4 * monthsOf(s, e).length, // на месяц: дневные кампании, дневные объявления, месячный эталон, правила Hub
    registryTab: MA_TABS.Meta,
    dealers: (values, registry) => accountDealers(values, registry, 'Meta_Ad_Account_ID', 'Meta_Token', 'Meta', 'accountId'),
    // по месяцам, как Force load selective (SPLIT_BY_MONTH): за длинный период Meta отвечает «unknown error (code 1)»
    async rows(d, ctx) {
      let out = [];
      for (const m of monthsOf(ctx.startDate, ctx.endDate)) out = out.concat(await metaDealerRows({ ...d, ...ctx, startDate: m.from, endDate: m.to }));
      return out;
    }
  },
  google: {
    name: 'Google Ads',
    halfLabel: 'Google_Token / Google_Customer_ID',
    native: 'Spend_USD', cur: '$', // сумма API в валюте аккаунта; EUR-аккаунты applyRates переводит в USD, как Apps Script
    units: () => 3, // показы, объявления, эталон и фильтры
    registryTab: MA_TABS.Google,
    dealers: (values, registry) => accountDealers(values, registry, 'Google_Customer_ID', 'Google_Token', 'Google', 'customerId', (r, h) => {
      const dealerId = r[0] ? r[0].toString().trim() : '';
      const raw = h.indexOf('Dealer_Type') > -1 && r[h.indexOf('Dealer_Type')] ? r[h.indexOf('Dealer_Type')].toString().trim().toLowerCase() : '';
      return { dealerType: dealerId.toLowerCase().includes('distributor') ? 'Дистрибьютор' : raw === 'системный' ? 'Системный' : raw === 'не системный' ? 'Не системный' : /^dealer_/i.test(dealerId) ? 'Дилер' : 'Не указан' };
    }),
    /** Ключи приложения Google (секреты GitHub) и правила Autoreport Hub (Registry + Overrides). */
    async prepare(token, say) {
      const keys = { clientId: process.env.GOOGLE_ADS_CLIENT_ID, clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET, developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN };
      const lost = Object.entries({ GOOGLE_ADS_CLIENT_ID: keys.clientId, GOOGLE_ADS_CLIENT_SECRET: keys.clientSecret, GOOGLE_ADS_DEVELOPER_TOKEN: keys.developerToken })
        .filter(([, v]) => !v).map(([k]) => k);
      if (lost.length) throw new Error('Нет секретов GitHub для Google Ads: ' + lost.join(', ') + ' (Settings → Secrets and variables → Actions)');
      try {
        const [reg, ov] = await Promise.all([readSheet(token, HUB_ID, 'Registry'), readSheet(token, HUB_ID, 'Overrides').catch(() => [])]);
        return { keys, hub: { registry: parseHubRegistry(reg), overrides: parseHubOverrides(ov) } };
      } catch (e) {
        say(`⚠️ Autoreport Hub не прочитан — конверсии Google без правил Hub (как в Apps Script при той же ошибке). ${e.message}`);
        return { keys };
      }
    },
    rows: (d, ctx) => googleDealerRows({ ...d, ...ctx })
  }
};

/**
 * Срез конверсий до Autoreport Hub (Gaps_HubCap.gs, hcDaily 09:00) над свежими строками — до записи и сверки.
 * Остальные площадки дилера — из BigQuery, как читает оригинал. Ошибка чтения Hub или медиаплана — срез пропускается с ⚠️.
 */
async function hubCap(rows, platform, start, end, token, say, detail) {
  let registry; let mapping = {};
  try {
    registry = parseAdsRegistry(await readSheet(token, HUB_ID, 'Registry'));
    mapping = parseMapping(await readSheet(token, HUB_ID, 'Mapping').catch(() => []));
  } catch (e) {
    say(`⚠️ Срез до Hub не выполнен: Autoreport Hub не прочитан. ${e.message}`);
    return;
  }
  // остальные площадки дилера — из D1 (база отчётов), а не из BigQuery: GitHub пишет все площадки сам
  const others = d1Query('SELECT Dealer_ID, Platform, Date, Campaign_Name, SUM(IFNULL(Conversions, 0)) AS Conversions, ' +
    'SUM(IFNULL(Spend_USD, 0)) AS Spend_USD, SUM(IFNULL(Spend_KZT, 0)) AS Spend_KZT FROM daily_statistics ' +
    `WHERE Platform != ${sqlLiteral(platform)} AND Date BETWEEN ${sqlLiteral(start)} AND ${sqlLiteral(end)} GROUP BY 1, 2, 3, 4`);
  const r = await applyHubCap(rows, platform, { registry, mapping, others, readAds: (reg) => readSheet(token, reg.ss, reg.sheet) });
  detail.hubCap = { cut: r.cut, dealers: r.dealers.length, errors: r.errors.length };
  say(`Срез до Autoreport Hub (как hcDaily в Apps Script): ${r.cut ? `−${r.cut} конв. у ${r.dealers.length} дилеро-месяцев` : 'срезать нечего'}.` +
    (r.dealers.length ? ' ' + r.dealers.map((d) => `${d.dealer}: ${d.before} → ${d.before - d.cut}`).join('; ') : ''));
  if (r.errors.length) {
    say(`⚠️ Медиаплан (Ads Data) не прочитан — у этих дилеров срез не сделан (откройте таблицу сервисному аккаунту autoreport-github@astana-motors-accounts.iam.gserviceaccount.com как «Читатель»):`);
    for (const e of r.errors) say('- ' + e);
  }
}

/**
 * Итог сверки дилера: exact — всё 1:1; near — строки и конверсии те же, расход отличается меньше чем на 1 (поздние списания
 * кабинета после выгрузки Apps Script, округление); diff — что именно отличается.
 */
export function verdict(r, cur) {
  if (r.ok) return { level: 'exact', text: '✅ 1:1' };
  const dSpend = r.other.spend - r.bq.spend;
  const fmt = (v) => (v >= 0 ? '+' : '') + (Math.abs(v) < 10 ? Math.round(v * 100) / 100 : Math.round(v)).toLocaleString('ru-RU');
  if (r.bq.n === r.other.n && r.bq.conv === r.other.conv && Math.abs(dSpend) < 1) return { level: 'near', text: `≈ расход ${fmt(dSpend)} ${cur}` };
  const parts = [];
  if (r.bq.n !== r.other.n) parts.push(`строк ${fmt(r.other.n - r.bq.n)}`);
  if (r.bq.conv !== r.other.conv) parts.push(`конв. ${fmt(r.other.conv - r.bq.conv)}`);
  if (Math.abs(dSpend) >= 0.01) parts.push(`расход ${fmt(dSpend)} ${cur}`);
  return { level: 'diff', text: '⚠️ ' + parts.join(', ') };
}

/** Как run*ETL_ForceReload: кабинеты разворачиваются (ячейка Total + реестр), без токена или ID — пропуск. */
function accountDealers(values, registry, accCol, tokCol, platform, idKey, extra = () => ({})) {
  const h = values[0] || [];
  const cTok = h.indexOf(tokCol);
  const cId = h.indexOf(accCol);
  if (cTok === -1 || cId === -1) throw new Error(`В листе Total нет колонок ${tokCol} / ${accCol}`);
  const rows = expandAccounts(values, accCol, tokCol, platform, registry);
  const list = [];
  const halfFilled = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const dealerId = r[0] ? r[0].toString().trim() : '';
    const acc = r[cId];
    const token = r[cTok];
    if (!acc || !token) { if (acc || token) halfFilled.push(dealerId); continue; }
    list.push({ dealerId, [idKey]: String(acc).trim(), token: String(token).trim(), ...extra(r, h) });
  }
  return { list, halfFilled };
}

async function main() {
  const platformKey = arg('platform', 'yandex').toLowerCase();
  const P = PLATFORMS[platformKey];
  if (!P) throw new Error('Неизвестная площадка: ' + platformKey);
  const win = defaultWindow();
  const start = arg('start', win.start);
  const end = arg('end', win.end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    throw new Error(`Неверный период: ${start} — ${end}`);
  }
  const only = arg('dealers').split(',').map((s) => s.trim()).filter(Boolean);
  const noWrite = arg('no_write') === '1';
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-etl-' + platformKey;
  const summary = [`# Выгрузка ${P.name}: ${start} — ${end}${noWrite ? ' (без записи)' : ''}`];
  const say = (s) => { console.log(s); summary.push(s); };

  {
    d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'],
      [{ id: runId, kind: 'etl:' + platformKey + (noWrite ? ':dry' : ''), started: new Date().toISOString(), status: 'running' }]).join('\n'), 'run-start');
  }

  let status = 'done';
  const detail = { start, end, dealers: 0, failed: [], rows: 0 };
  if (process.env.GITHUB_RUN_ID) detail.ghRun = String(process.env.GITHUB_RUN_ID); // итог действия на сайте берётся только из своего запуска
  if (only.length) detail.subset = 1; // выгрузка части дилеров: ежедневная копия из BigQuery по ней не судит, перенесена ли площадка
  // Ход выгрузки — в D1 через HTTP API Cloudflare без ожидания (не тормозит выгрузку), не чаще раза в 4 с.
  const prog = makeProgress({ write: (progress) => d1HttpRun(`UPDATE etl_runs SET detail = ?1 WHERE id = ?2 AND status = 'running'`,
    [JSON.stringify({ start, end, progress }), runId]), minGapMs: 4000 });
  prog.phase('prepare');
  try {
    const token = tokenProvider(ETL_SCOPES);
    prog.source('Google Таблицы: All_Tokens → лист Total, ETL_Engine → Dictionaries; D1 → fx_rates', true);
    const [total, dictRows] = await Promise.all([
      readSheet(token, ALL_TOKENS_ID, 'Total'),
      readSheet(token, ETL_SPREADSHEET_ID, 'Dictionaries')
    ]);
    const dicts = buildDictionaries(dictRows);
    const fxTables = buildFx({
      rates: d1Query('SELECT month, Platform, Dealer_ID, usd, eur FROM fx_rates'),
      currencies: d1Query('SELECT Platform, Dealer_ID, currency FROM fx_account_currency')
    });
    let registry = {};
    if (P.registryTab) {
      try {
        registry = parseRegistry(await readSheet(token, MA_REGISTRY_ID, P.registryTab), P.name);
      } catch (e) {
        // как maRegistry_: без реестра работают только кабинеты из ячейки Total
        say(`⚠️ Реестр кабинетов (вкладка «${P.registryTab}») не прочитан — только кабинеты из Total. ${e.message}`);
      }
    }
    const extraCtx = P.prepare ? await P.prepare(token, say) : {};
    const { list, halfFilled } = P.dealers(total, registry);
    // Dealer_ID сравнивается без учёта регистра: в медиаплане (Registry Hub) «Dealer_BYD_Citystore», в Total «Dealer_BYD_CityStore» — один дилер.
    let dealers = list;
    if (only.length) {
      const res = resolveDealerIds(only, list.map((d) => d.dealerId));
      dealers = list.filter((d) => res.matched.has(d.dealerId));
      for (const r of res.renamed) say(`ℹ️ ${r.asked} в листе Total записан как ${r.used.join(', ')} — выгружается он.`);
      const totalIds = total.slice(1).map((r) => String((r || [])[0] ?? '').trim()).filter(Boolean);
      if (res.missing.length) say(`⚠️ Нельзя выгрузить: ${res.missing.join(', ')}`);
      // запрошенный дилер, которого нельзя выгрузить, — ошибка запуска, а не тихий успех с нулём строк
      for (const m of res.missing) {
        const like = similarIds(m, totalIds);
        const why = totalIds.some((t) => idKey(t) === idKey(m)) ? `в листе Total дилер есть, но для ${P.name} не заполнены ${P.halfLabel}`
          : like.length ? `такого ID нет в листе Total, похожий ID: ${like.join(', ')} — запишите Dealer_ID одинаково в Registry Autoreport Hub и в Total`
            : 'его нет в листе Total';
        detail.failed.push({ dealer: m, error: `Дилер не подключён к выгрузке ${P.name}: ${why}` });
      }
    }
    if (halfFilled.length) say(`⚠️ Заполнено только одно из двух полей (${P.halfLabel}), дилер пропущен, как в Apps Script: ${halfFilled.join(', ')}`);
    say(`Словарь: ${dicts.models.length} моделей, ${dicts.brands.length} брендов. Курсов в D1: ${fxTables.rates.size}.`);

    // Сбор: строки одного дилера из нескольких строк Total складываются вместе, ошибка — только у этого дилера.
    prog.phase('collect');
    prog.setTotal(dealers.length * P.units(start, end));
    const byDealer = new Map();
    const keep = {}; // реестр кампаний, которые обнулять нельзя (MESSAGING_KEEP_CONVERSIONS), — заполняют Meta и Google
    detail.skipped = [];
    const collect = async (d) => {
      // один кабинет дилера с ошибкой — весь дилер не пишется (иначе его срез заменился бы неполными данными)
      if (byDealer.get(d.dealerId) === null) return;
      try {
        // nbRates пуст: Spend_USD, который площадка считает сама, сразу пересчитывается по курсу из D1 (applyRates).
        prog.source(`${P.name} API → ${d.dealerId}` + (d.accountId || d.account ? ' · кабинет ' + (d.accountId || d.account) : '') + ` · ${start} — ${end}`);
        const rows = await P.rows(d, { ...extraCtx, startDate: start, endDate: end, dicts, nbRates: {}, keep, warn: say, onChunk: () => prog.tick(d.dealerId) });
        prog.rows(rows.length);
        byDealer.set(d.dealerId, (byDealer.get(d.dealerId) || []).concat(rows));
      } catch (err) {
        if (err.noAccess) {
          // кабинет недоступен и Apps Script (тот же доступ) — грузятся остальные кабинеты дилера; если других нет, дилер не трогается
          detail.skipped.push({ dealer: d.dealerId, error: String(err.message).slice(0, 300) });
          return;
        }
        detail.failed.push({ dealer: d.dealerId, error: String(err.message).slice(0, 300) });
        byDealer.set(d.dealerId, null);
      }
    };
    for (const d of dealers) await collect(d);
    // Лимит запросов площадки (Google Ads «Resource has been exhausted», 429): пауза и второй проход только по этим дилерам.
    const limited = [...new Set(detail.failed.filter((f) => isQuotaError(f.error)).map((f) => f.dealer))];
    if (limited.length) {
      say(`⏳ Лимит запросов ${P.name} у ${limited.length} дилер.: пауза ${Math.round(QUOTA_PAUSE_MS / 1000)} с и повтор.`);
      await new Promise((r) => setTimeout(r, QUOTA_PAUSE_MS));
      detail.failed = detail.failed.filter((f) => !limited.includes(f.dealer));
      for (const id of limited) byDealer.delete(id);
      for (const d of dealers.filter((x) => limited.includes(x.dealerId))) await collect(d);
      const still = detail.failed.filter((f) => limited.includes(f.dealer)).length;
      say(still ? `⚠️ После повтора лимит остался у ${still} дилер. — их прежние данные не тронуты.` : '✅ Повтор после лимита прошёл у всех.');
    }
    const okDealers = [...byDealer.keys()].filter((k) => byDealer.get(k) !== null);
    let allRows = [];
    for (const k of okDealers) allRows = allRows.concat(byDealer.get(k));
    const fx = applyRates(allRows, fxTables);
    allRows = stripEmptyRows(allRows);
    const zeroed = awarenessZeroOut(allRows, keep);
    if (zeroed.rows) say(`Awareness: обнулено ${zeroed.convs} конверсий в ${zeroed.rows} строках (как в Apps Script).`);
    if (allRows.length) await hubCap(allRows, P.name, start, end, token, say, detail);
    detail.dealers = okDealers.length;
    detail.rows = allRows.length;
    detail.fxMissing = fx.missing;
    if (fx.missing.length) {
      const byMonth = {};
      for (const m of fx.missing) (byMonth[m.month] = byMonth[m.month] || []).push(m.Dealer_ID + ' · ' + m.Platform + ' (' + m.need.join('+') + ')');
      for (const [month, list] of Object.entries(byMonth)) {
        say(`❌ Нет курса за ${month}: ${list.join(', ')}. Строки записаны, пересчитанная сумма пустая — задайте курс на сайте («Курсы валют») и нажмите «Пересчитать».`);
      }
    }

    // Запись: срез «площадка × дилер × период» заменяется целиком, только у успешно выгруженных дилеров.
    prog.phase('write');
    prog.source(`D1 → daily_statistics: замена ${P.name} × ${okDealers.length} дилер. × ${start} — ${end}`, true);
    prog.rows(allRows.length);
    if (!noWrite && okDealers.length) {
      const parts = [];
      for (const dealer of okDealers) {
        parts.push(`DELETE FROM daily_statistics WHERE Platform = ${sqlLiteral(P.name)} AND Dealer_ID = ${sqlLiteral(dealer)} ` +
          `AND Date BETWEEN ${sqlLiteral(start)} AND ${sqlLiteral(end)};`);
      }
      parts.push(...buildInserts('daily_statistics', [...DAILY_COLUMNS, 'Spend_Native', 'Currency'], allRows));
      // эти дилер × площадка × даты загружены прямо из кабинета — ежедневная копия из BigQuery (bq_bridge.mjs) их не перезапишет
      parts.push(...buildInserts('cc_restored', ['dealer', 'platform', 'date_from', 'date_to', 'at'],
        okDealers.map((dealer) => ({ dealer, platform: P.name, date_from: start, date_to: end, at: new Date().toISOString() }))));
      d1ExecFile(parts.join('\n') + '\n', 'etl-' + platformKey);
    }

    // Эталон для «Недолётов»: что кабинет отдал за месяц (с записью и без) — D1 сверяется с ним, а не с «Ads Data»
    if (okDealers.length) {
      const cab = cabinetRecords(allRows, okDealers, P.name, start, end, defaultWindow().end);
      if (cab.length) {
        try {
          d1ExecFile(buildInserts('cc_cabinet', ['month', 'dealer', 'platform', 'date_to', 'conv', 'usd', 'kzt', 'camps', 'at'], cab)
            .map((q) => q.replace(/^INSERT INTO/, 'INSERT OR REPLACE INTO')).join('\n') + '\n', 'cabinet');
          say(`Итоги кабинетов для сверки недолётов: ${cab.length} дилеро-месяцев.`);
        } catch (e) {
          say('⚠️ Итоги кабинетов для недолётов не записаны (на выгрузку не влияет): ' + String(e.message).slice(0, 200));
        }
      }
    }

    prog.phase('compare');
    prog.source('BigQuery → marketing_data.daily_statistics (сверка 1:1)', true);
    // Сверка с BigQuery (Apps Script пишет туда же каждую ночь) по дилерам за тот же период.
    // Сверка — только контроль, пока Apps Script ещё пишет BigQuery: её сбой не портит записанное и не красит запуск.
    let bq = null;
    try {
      ({ rows: bq } = await bqSelect(await token(), {
        project: 'astana-motors-accounts', location: 'EU',
        // расход сверяется в валюте кабинета (P.native): пересчёт в тенге зависит от курсов, а не от выгрузки
        sql: `SELECT Dealer_ID, Platform, COUNT(*) AS n, ROUND(SUM(${P.native}), 2) AS spend, SUM(Conversions) AS conv ` +
          `FROM \`astana-motors-accounts.marketing_data.daily_statistics\` WHERE Platform = '${P.name}' ` +
          `AND Date BETWEEN '${start}' AND '${end}' GROUP BY Dealer_ID, Platform`
      }));
    } catch (e) {
      say(`ℹ️ Сверка с BigQuery пропущена (на запись не влияет): ${String(e.message).slice(0, 200)}`);
    }
    const mine = {};
    for (const r of allRows) {
      const m = (mine[r.Dealer_ID] = mine[r.Dealer_ID] || { Dealer_ID: r.Dealer_ID, Platform: P.name, n: 0, spend: 0, conv: 0 });
      m.n++; m.spend += r[P.native] || 0; m.conv += r.Conversions;
    }
    Object.values(mine).forEach((m) => { m.spend = Math.round(m.spend * 100) / 100; });
    const bqScoped = (bq || []).filter((r) => okDealers.includes(r.Dealer_ID));
    const cmp = compareAggregates(bqScoped, bq ? Object.values(mine) : []);
    say(`\n| Дилер | Строк BQ / новых | Расход BQ, ${P.cur} | Расход новый, ${P.cur} | Конв. BQ / новых | Сверка |`);
    say('|---|---:|---:|---:|---:|---|');
    for (const r of cmp.rows.sort((a, b) => String(a.Dealer_ID).localeCompare(String(b.Dealer_ID)))) {
      r.verdict = verdict(r, P.cur);
      say(`| ${r.Dealer_ID} | ${r.bq.n} / ${r.other.n} | ${Math.round(r.bq.spend).toLocaleString('ru-RU')} | ` +
        `${Math.round(r.other.spend).toLocaleString('ru-RU')} | ${r.bq.conv} / ${r.other.conv} | ${r.verdict.text} |`);
    }
    for (const f of detail.failed) say(`| ${f.dealer} | — | — | — | — | ❌ ${f.error.replace(/\|/g, '/')} |`);
    if (detail.skipped.length) {
      say(`\nℹ️ Нет доступа к кабинету — Apps Script с тем же доступом его тоже не выгружает, на итог запуска не влияет:`);
      for (const s of detail.skipped) say(`- ${s.error}`);
    }
    const exact = cmp.rows.filter((r) => r.verdict.level === 'exact').length;
    const near = cmp.rows.filter((r) => r.verdict.level === 'near').length;
    say(`\nДилеров: ${okDealers.length} выгружено, ${detail.failed.length} с ошибкой. Строк: ${allRows.length}. ` +
      `Сверка с BigQuery из ${cmp.rows.length}: ✅ 1:1 — ${exact}, ≈ (расход отличается меньше чем на 1 ${P.cur}) — ${near}, ⚠️ отличается — ${cmp.rows.length - exact - near}.`);
    detail.match = exact + near;
    detail.compared = cmp.rows.length;

    if (cmp.rows.length) {
      // bq_spend_kzt / new_spend_kzt: расход в валюте кабинета (P.native), имена колонок исторические
      const cols = ['run_id', 'tbl', 'month', 'Dealer_ID', 'Platform', 'bq_rows', 'new_rows', 'bq_spend_kzt', 'new_spend_kzt', 'bq_conversions', 'new_conversions', 'ok'];
      d1ExecFile(buildInserts('migration_check', cols, cmp.rows.map((r) => ({ run_id: runId, tbl: 'etl_' + platformKey + (noWrite ? '_dry' : ''),
        month: start + '..' + end, Dealer_ID: r.Dealer_ID, Platform: P.name, bq_rows: r.bq.n, new_rows: r.other.n,
        bq_spend_kzt: r.bq.spend, new_spend_kzt: r.other.spend, bq_conversions: r.bq.conv, new_conversions: r.other.conv,
        ok: r.verdict.level === 'diff' ? 0 : 1 }))).join('\n'), 'etl-checks');
    }
    if (detail.failed.length || fx.missing.length) status = 'failed';
  } catch (err) {
    status = 'failed';
    detail.error = err.message;
    say('\n❌ Ошибка: ' + err.message);
  } finally {
    detail.summary = summary.join('\n').slice(0, 30000); // итог виден и на сайте, и без журнала GitHub
    {
      try {
        d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, ` +
          `detail = ${sqlLiteral(JSON.stringify(detail))} WHERE id = ${sqlLiteral(runId)};`, 'run-end');
      } catch (e) {
        say('⚠️ Не удалось записать итог в etl_runs: ' + e.message);
      }
    }
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  }
  if (status !== 'done') process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('run_platform.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
