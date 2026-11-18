#!/usr/bin/env node
// «Расход Haval/Tank» → Cloudflare D1, таблица haval_spend (вместо BigQuery из инструкции владельца воркера).
// Источник: https://fb-leads-haval.d-sarybek.workers.dev/report (только чтение), ключ — секрет HAVAL_REPORT_KEY.
// Каждый день: забрать последние 28 дней и ЗАМЕНИТЬ это окно в таблице (DELETE окна + INSERT одним файлом).
// История: FROM/TO (YYYY-MM-DD) — режется на куски по 93 дня, каждый кусок заменяется отдельно.
// Ничего не пишется, если: ответ не 200 (502 — Meta отдала не все кабинеты), число строк не сходится с X-Report-Rows,
// строка вне периода или с битыми полями, пустой ответ за ежедневное окно. NO_WRITE=1 — только забрать и показать.

import fs from 'node:fs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { buildInserts, buildReplaceFile, sqlLiteral } from './lib/sql.mjs';
import { applyRates, buildFx } from './lib/fx.mjs';
import { DAILY_COLUMNS } from './migrate_bq.mjs';
import { PLATFORM, loadMap, nightlyMeta, plan, toDaily } from './lib/haval_dealers.mjs';

export const REPORT_URL = 'https://fb-leads-haval.d-sarybek.workers.dev/report';
export const TABLE = 'haval_spend';
export const COLUMNS = ['date', 'account_id', 'account_name', 'dealership', 'mark', 'currency', 'spend', 'impressions', 'clicks', 'meta_leads', 'loaded'];
const MAX_DAYS = 93;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const summary = [];
const say = (s) => { console.log(s); summary.push(s); };

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/** Период FROM..TO → куски не длиннее 93 дней. */
export function chunks(from, to, max = MAX_DAYS) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('Даты — в виде ГГГГ-ММ-ДД');
  if (from > to) throw new Error(`Начало ${from} позже конца ${to}`);
  const out = [];
  for (let a = from; a <= to; a = addDays(a, max)) {
    const b = addDays(a, max - 1);
    out.push({ from: a, to: b < to ? b : to });
  }
  return out;
}

/** Заголовок X-Report-Period → {from, to} (берутся первые две даты, формат разделителя не важен). */
export function parsePeriod(header) {
  const m = String(header || '').match(/\d{4}-\d{2}-\d{2}/g);
  return m && m.length >= 2 ? { from: m[0], to: m[1] } : null;
}

const toNum = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));

/** NDJSON-ответ → строки таблицы. Битая строка — ошибка всей выгрузки (лучше не записать, чем записать криво). */
export function parseRows(text, period, loaded) {
  const rows = [];
  const seen = new Map();
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { throw new Error(`Строка ${i + 1}: не JSON`); }
    const r = {
      date: String(o.date || ''),
      account_id: String(o.account_id ?? '').trim(),
      account_name: o.account_name == null ? null : String(o.account_name),
      dealership: o.dealership == null || o.dealership === '' ? null : String(o.dealership),
      mark: o.mark == null ? '' : String(o.mark),
      currency: o.currency == null || o.currency === '' ? null : String(o.currency),
      spend: toNum(o.spend),
      impressions: toNum(o.impressions),
      clicks: toNum(o.clicks),
      meta_leads: toNum(o.meta_leads),
      loaded
    };
    if (!DATE_RE.test(r.date)) throw new Error(`Строка ${i + 1}: дата «${r.date}»`);
    if (period && (r.date < period.from || r.date > period.to)) throw new Error(`Строка ${i + 1}: дата ${r.date} вне периода ${period.from}..${period.to}`);
    if (!r.account_id) throw new Error(`Строка ${i + 1}: нет account_id`);
    for (const k of ['spend', 'impressions', 'clicks', 'meta_leads']) {
      if (!Number.isFinite(r[k]) || r[k] < 0) throw new Error(`Строка ${i + 1}: ${k} = «${o[k]}»`);
    }
    for (const k of ['impressions', 'clicks', 'meta_leads']) r[k] = Math.round(r[k]);
    // Кабинет «Haval+Tank» приходит строкой на каждую марку; полный повтор той же строки (кабинет виден через два BM) пропускаем.
    const key = r.date + '|' + r.account_id + '|' + r.mark;
    const same = (a) => ['spend', 'impressions', 'clicks', 'meta_leads'].every((k) => a[k] === r[k]);
    if (seen.has(key)) {
      if (same(seen.get(key))) return;
      throw new Error(`Повтор с разными цифрами: ${r.date} × кабинет ${r.account_id} × ${r.mark || 'без марки'}`);
    }
    seen.set(key, r);
    rows.push(r);
  });
  return rows;
}

/** SQL замены окна: удалить строки периода и вставить свежие. */
export function replaceSql(period, rows) {
  return buildReplaceFile({
    table: TABLE, columns: COLUMNS, rows,
    where: `date BETWEEN ${sqlLiteral(period.from)} AND ${sqlLiteral(period.to)}`
  });
}

const HTTP_HINT = {
  403: 'неверный ключ — проверьте секрет HAVAL_REPORT_KEY в GitHub',
  503: 'в воркере fb-leads-haval не задан REPORT_KEY',
  502: 'Meta отдала не все кабинеты — выгрузка неполная, ничего не записано; повторится завтра (или запустите вручную позже)'
};

/** Забрать один период. */
export async function fetchPeriod(key, q, fetchFn = fetch) {
  const url = new URL(REPORT_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('format', 'ndjson');
  if (q.from) { url.searchParams.set('from', q.from); url.searchParams.set('to', q.to); } else url.searchParams.set('days', String(q.days || 28));
  const res = await fetchFn(url, { headers: { Accept: 'application/x-ndjson' } });
  const body = await res.text();
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}${HTTP_HINT[res.status] ? ' — ' + HTTP_HINT[res.status] : ''}${body ? '\n' + body.slice(0, 800) : ''}`);
  }
  const period = parsePeriod(res.headers.get('X-Report-Period')) || (q.from ? { from: q.from, to: q.to } : null);
  if (!period) throw new Error('Нет заголовка X-Report-Period — непонятно, какое окно заменять; ничего не записано');
  const loaded = new Date().toISOString();
  const rows = parseRows(body, period, loaded);
  const declared = res.headers.get('X-Report-Rows');
  const got = body.split(/\r?\n/).filter((l) => l.trim()).length; // строки ответа, включая пропущенные повторы
  if (declared !== null && declared !== '' && Number(declared) !== got) {
    throw new Error(`Воркер заявил ${declared} строк, пришло ${got} — ответ обрезан; ничего не записано`);
  }
  const unmapped = Number(res.headers.get('X-Unmapped-Accounts') || 0);
  return { period, rows, unmapped };
}

async function main() {
  const key = String(process.env.HAVAL_REPORT_KEY || '').trim();
  const from = String(process.env.FROM || '').trim();
  const to = String(process.env.TO || '').trim();
  const noWrite = process.env.NO_WRITE === '1';
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-haval';
  const detail = { periods: [] };
  let status = 'done';

  if (!noWrite) d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'], [{ id: runId, kind: 'haval', started: new Date().toISOString(), status: 'running' }]).join('\n'), 'haval-start');
  try {
    if (!key) throw new Error('Не задан секрет HAVAL_REPORT_KEY (GitHub → Settings → Secrets and variables → Actions)');
    if (Boolean(from) !== Boolean(to)) throw new Error('Для истории укажите и начало, и конец');
    const parts = from ? chunks(from, to) : [{ days: 28 }];
    // Кабинеты → дилеры отчёта (daily_statistics, Meta). Ночная выгрузка Meta важнее: её кабинеты и дилеры не трогаем.
    const map = loadMap();
    const nightly = nightlyMeta(d1Query(`SELECT Dealer_ID, account_id FROM cc_dealers WHERE Platform = ${sqlLiteral(PLATFORM)}`));
    const fxTables = buildFx({
      rates: d1Query('SELECT month, Platform, Dealer_ID, usd, eur FROM fx_rates'),
      currencies: d1Query('SELECT Platform, Dealer_ID, currency FROM fx_account_currency')
    });
    let lastReport = null;
    for (const q of parts) {
      const { period, rows, unmapped } = await fetchPeriod(key, q);
      if (!rows.length && !from) throw new Error(`За ${period.from}..${period.to} пришло 0 строк — на Meta не похоже; окно не тронуто`);
      const spend = rows.reduce((s, r) => s + r.spend, 0);
      const accounts = new Set(rows.map((r) => r.account_id)).size;
      say(`${period.from}..${period.to}: строк ${rows.length}, кабинетов ${accounts}, расход ${spend.toFixed(2)} USD, лидов Meta ${rows.reduce((s, r) => s + r.meta_leads, 0)}`);
      if (unmapped > 0) say(`  ⚠️ Кабинетов без дилера в справочнике воркера: ${unmapped} — напишите владельцу воркера fb-leads-haval`);

      const { write, report } = plan(rows, map, nightly);
      lastReport = report;
      const daily = toDaily(rows, write);
      const fx = applyRates(daily, fxTables);
      for (const m of fx.missing) say(`  ❌ Нет курса USD за ${m.month} (${m.Dealer_ID}) — расход в тенге пустой; задайте курс на сайте («Курсы валют»).`);
      const ids = [...new Set([...write.values()].map((m) => m.dealerId))];
      if (ids.length) say(`  В отчёт (Meta): дилеров ${ids.length}, строк ${daily.length}, расход ${daily.reduce((s, r) => s + (r.Spend_Native || 0), 0).toFixed(2)} USD`);
      if (!noWrite) {
        let sql = replaceSql(period, rows);
        if (ids.length) {
          sql += `DELETE FROM daily_statistics WHERE Platform = ${sqlLiteral(PLATFORM)} AND Dealer_ID IN (${ids.map(sqlLiteral).join(', ')}) ` +
            `AND Date BETWEEN ${sqlLiteral(period.from)} AND ${sqlLiteral(period.to)};\n` +
            buildInserts('daily_statistics', [...DAILY_COLUMNS, 'Spend_Native', 'Currency'], daily).join('\n') + '\n';
        }
        d1ExecFile(sql, `haval-${period.from}`);
      }
      detail.periods.push({ ...period, rows: rows.length, accounts, spend: Math.round(spend * 100) / 100, unmapped, dealers: ids.length, dailyRows: daily.length });
    }
    if (lastReport) {
      say('');
      say('| Кабинет | Название | Дилер (CRM) | Марка | Расход, USD | В отчёте |');
      say('|---|---|---|---|---|---|');
      const c = (v) => String(v || '').replace(/\|/g, '/');
      for (const a of lastReport) say(`| ${a.account_id} | ${c(a.account_name)} | ${c(a.dealership) || '—'} | ${c(a.mark)} | ${a.spend.toFixed(2)} | ${c(a.status)} |`);
      say('');
    }
    say(noWrite ? 'Проверочный запуск (NO_WRITE=1): в базу ничего не записано.' : `✅ Записано в D1 → таблица ${TABLE}.`);
  } catch (e) {
    status = 'failed';
    detail.error = String(e.message || e).slice(0, 1000);
    say('❌ ' + detail.error);
  }
  if (!noWrite) d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, detail = ${sqlLiteral(JSON.stringify(detail))} WHERE id = ${sqlLiteral(runId)};`, 'haval-end');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  if (status === 'failed') process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('haval_spend.mjs')) main();
