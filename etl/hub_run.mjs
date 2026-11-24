// «Autoreport Hub» на сайте: тот же код Hub (etl/hub/*.gs, без изменений) выполняется в GitHub Actions через переходник lib/gas.mjs.
// Вкладки Hub (Registry, Mapping, Config, Overrides, Log, Журнал ошибок, Статус, Проверка, …) живут в D1 (hub_sheets) и
// правятся в разделе «Autoreport Hub» сайта; медиапланы (лист «Ads Data») пишутся в Google Таблицы, как раньше.
// Registry / Mapping / Config / Overrides после каждого запуска копируются в старую таблицу Hub — их читают ночная выгрузка,
// срез до Hub и недолёты.
//
// Переменные:
//   HUB_MODE    daily | monthly-auto | monthly | custom | dealer | check | merge | merge-preview | import | mirror | continue
//   HUB_MONTHS  для custom/dealer: 2026-05 или 2026-01..2026-07 (для dealer пусто — текущий месяц, как «ежедневно»)
//   HUB_DEALERS для dealer: Dealer_ID через запятую
//   HUB_DRY=1   ничего не писать в медиапланы, Telegram и старую таблицу Hub (вкладки Hub в D1 пишутся — это журнал запуска)
// Токены: Google Ads — секреты GOOGLE_ADS_* и токен MCC из листа Total; Meta/TikTok/Яндекс — токен кабинета из листа Total
// (или общий HUB_META_TOKEN / HUB_TIKTOK_TOKEN / HUB_YANDEX_TOKEN, если задан); Telegram — HUB_TELEGRAM_BOT_TOKEN / HUB_TELEGRAM_CHAT_ID.
// Очередь не успела за 80 минут — задание само запускает себя снова в режиме continue (как триггер «через 1 минуту» в Apps Script).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSheet, ALL_TOKENS_ID } from './lib/sheets.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { sqlLiteral } from './lib/sql.mjs';
import { HUB_ID, GOOGLE_LOGIN_CUSTOMER_ID } from './platforms/googleads.mjs';
import { donorCandidates } from './google_mcc.mjs';
import {
  Spreadsheet, chunks, fromJsonGrid, toJsonGrid, loadGas, makeGlobals, openGoogleSpreadsheet, writeGoogleSheet, httpSync
} from './lib/gas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EDITABLE = ['Registry', 'Mapping', 'Config', 'Overrides'];
const PROPS_SHEET = '__props';
const PART_CHARS = 25000; // ≤ 75 КБ даже кириллицей: у D1 предел выражения 100 КБ
const RUN_BUDGET_MS = 80 * 60000; // задание ограничено 90 минутами
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/* ---------------- вкладки Hub в D1 ---------------- */

export function loadHubSheets(query = d1Query, only) {
  const rows = query('SELECT name, part, data FROM hub_sheets' + (only ? ' WHERE name = ' + sqlLiteral(only) : '') + ' ORDER BY name, part');
  const by = new Map();
  for (const r of rows) by.set(r.name, (by.get(r.name) || '') + r.data);
  return new Map([...by].map(([n, s]) => [n, fromJsonGrid(JSON.parse(s))]));
}

export function saveSql(sheets) {
  const at = new Date().toISOString();
  const out = [];
  for (const [name, grid] of sheets) {
    out.push(`DELETE FROM hub_sheets WHERE name = ${sqlLiteral(name)};`);
    chunks(JSON.stringify(toJsonGrid(grid)), PART_CHARS).forEach((part, p) => {
      out.push(`INSERT INTO hub_sheets (name, part, data, updated_at) VALUES (${sqlLiteral(name)}, ${p}, ${sqlLiteral(part)}, ${sqlLiteral(at)});`);
    });
  }
  return out.join('\n');
}

/** Registry во время запуска мог поменяться на сайте: переносим из запуска только last_run / last_status (по dealer_id). */
export function mergeRegistryStatus(current, ran) {
  if (!current || !current.length) return ran;
  const head = (g) => (g[0] || []).map((x) => String(x).trim());
  const hc = head(current); const hr = head(ran);
  const idC = hc.indexOf('dealer_id'); const idR = hr.indexOf('dealer_id');
  if (idC < 0 || idR < 0) return current;
  const byId = new Map(ran.slice(1).map((r) => [String(r[idR] || '').trim().toLowerCase(), r]));
  const out = current.map((r) => r.slice());
  for (const col of ['last_run', 'last_status']) {
    const c = hc.indexOf(col); const rc = hr.indexOf(col);
    if (c < 0 || rc < 0) continue;
    for (let i = 1; i < out.length; i++) {
      const src = byId.get(String(out[i][idC] || '').trim().toLowerCase());
      if (src && src[rc] !== undefined && src[rc] !== '') out[i][c] = src[rc];
    }
  }
  return out;
}

/* ---------------- токены из листа Total ---------------- */

const normAcc = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/^act_/, '').replace(/[-\s]/g, '');
const first = (v) => String(v == null ? '' : v).trim().split(/[,;\s]+/)[0];

/** platform → (dealer из Registry) → токен из Total: сначала строка с тем же кабинетом, потом с тем же Dealer_ID. */
export function totalTokens(total) {
  const h = (total[0] || []).map((x) => String(x).trim());
  const P = {
    meta: { tok: 'Meta_Token', acc: 'Meta_Ad_Account_ID', reg: 'meta_act_ids' },
    tiktok: { tok: 'TikTok_Token', acc: 'TikTok_Advertiser_ID', reg: 'tiktok_adv_ids' },
    yandex: { tok: 'Yandex_Token', acc: 'Yandex_Client_Login', reg: 'yandex_client_login' }
  };
  return (dealer, platform) => {
    const p = P[platform]; if (!p) return '';
    const ct = h.indexOf(p.tok); const ca = h.indexOf(p.acc);
    if (ct < 0) return '';
    const want = String(dealer[p.reg] || '').split(/[,;\s]+/).map(normAcc).filter(Boolean);
    const rows = total.slice(1);
    for (const r of rows) {
      if (ca >= 0 && first(r[ct]) && String(r[ca] || '').split(/[,;\s]+/).map(normAcc).some((a) => a && want.includes(a))) return first(r[ct]);
    }
    const id = String(dealer.dealer_id || '').trim().toLowerCase();
    for (const r of rows) if (String(r[0] || '').trim().toLowerCase() === id && first(r[ct])) return first(r[ct]);
    return '';
  };
}

/* ---------------- лимит Google Ads ---------------- */

/** Смещение Тихоокеанского времени от UTC в момент t, мс. */
function laOffset(t) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(t)) p[x.type] = +x.value;
  return { off: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t.getTime() / 1000) * 1000, p };
}
/** Полночь по Тихоокеанскому времени: k = 0 — начало текущих суток, 1 — следующая (так Google считает сутки квоты).
 *  Смещение пересчитывается для самой полуночи — в дни перевода часов сутки длятся 23 или 25 часов. */
export function pacificMidnight(now = new Date(), k = 1) {
  const { off, p } = laOffset(now);
  const wall = Date.UTC(p.year, p.month - 1, p.day + k);
  const guess = new Date(wall - off);
  return new Date(wall - laOffset(guess).off);
}
export const nextPacificMidnight = (now = new Date()) => pacificMidnight(now, 1);

/** Ответ 429 Google Ads → { resetAt, rateName } для дневного лимита; null — короткое ограничение частоты (секунды). */
export function quotaInfo(text, now = new Date()) {
  const s = String(text || '');
  if (!/RESOURCE_EXHAUSTED|429/.test(s)) return null;
  const delay = Number((/"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/.exec(s) || [])[1] || 0);
  const rateName = (/"rateName"\s*:\s*"([^"]+)"/.exec(s) || [])[1] || '';
  if (delay && delay <= 60 && !/day/i.test(rateName)) return null;
  return { resetAt: delay ? new Date(now.getTime() + delay * 1000) : nextPacificMidnight(now), rateName, delay };
}

/* ---------------- среда Hub ---------------- */

/**
 * Собрать среду Hub. Все внешние вызовы подменяемы (для самопроверки).
 * @returns {{ctx, hub: Spreadsheet, flushHub: Function, flushMps: Function, mails: string[]}}
 */
export function buildHub({ sheets, props, secretKeys, tokenFor2, getToken, http = httpSync, dry = false, log = console.log, saveHub, openMp }) {
  const hub = new Spreadsheet({ id: HUB_ID, title: 'Autoreport Hub', names: [...sheets.keys()].filter((n) => n !== PROPS_SHEET), load: (n) => sheets.get(n) || [] });
  const mps = new Map();
  const mails = [];
  const quota = []; // дневной лимит Google Ads исчерпан: { resetAt, rateName }
  const httpRaw = http;
  http = (url, o) => {
    const r = httpRaw(url, o);
    if (r.code === 429 && url.includes('googleads.googleapis.com')) { const q = quotaInfo(r.text); if (q) quota.push(q); }
    return r;
  };
  const open = openMp || ((id) => openGoogleSpreadsheet(getToken, id, http));
  /** Записать изменённые листы медиапланов; ошибка — наружу (её поймает код Hub, как ошибку setValues). */
  const flushMps = () => {
    try {
      for (const ss of mps.values()) for (const sh of ss.dirtySheets()) {
        if (dry) { log(`  (без записи) МП ${ss.getName()} → «${sh.getName()}»: ${sh.getLastRow()} строк`); sh.dirty = false; continue; }
        writeGoogleSheet(getToken, ss.getId(), sh, http);
      }
    } finally {
      mps.clear(); // следующий дилер / шаг читает таблицу заново, как Apps Script
    }
  };
  let stateSnap = JSON.stringify(Object.entries(props).filter(([k]) => !secretKeys.has(k)));
  /** @param {{withRegistry?: boolean}} o */
  const flushHub = (o = {}) => {
    const out = new Map();
    for (const sh of hub.dirtySheets()) {
      if (sh.getName() === 'Registry' && !o.withRegistry) continue;
      if (EDITABLE.includes(sh.getName()) && sh.getName() !== 'Registry' && !sh.created) { sh.dirty = false; continue; }
      out.set(sh.getName(), sh._grid());
    }
    const state = Object.entries(props).filter(([k]) => !secretKeys.has(k));
    const snap = JSON.stringify(state);
    if (snap !== stateSnap) out.set(PROPS_SHEET, state.map(([k, v]) => [k, v]));
    if (!out.size) return;
    saveHub(out);
    for (const n of out.keys()) { const sh = hub.getSheetByName(n); if (sh) { sh.dirty = false; sh.created = false; } }
    stateSnap = snap;
  };
  const globals = makeGlobals({
    active: hub, props, http, log,
    openById: (id) => { if (id === HUB_ID) return hub; if (!mps.has(id)) mps.set(id, open(id)); return mps.get(id); },
    onFlush: () => {}, // вкладки Hub и медиапланы пишутся после каждого дилера (step), не на каждый SpreadsheetApp.flush
    onMail: (subject, body) => mails.push(subject + '\n' + body)
  });
  if (dry) {
    const real = globals.UrlFetchApp.fetch;
    globals.UrlFetchApp.fetch = (url, opt) => {
      if (/api\.telegram\.org/.test(url)) { log('  (без записи) Telegram не отправлен'); return { getResponseCode: () => 200, getContentText: () => '{"ok":true}', getAllHeaders: () => ({}), getHeaders: () => ({}) }; }
      return real(url, opt);
    };
  }
  const ctx = loadGas(path.join(HERE, 'hub'), globals);
  ctx.HUB.MAX_RUN_MS = 1;                       // очередь отдаёт управление после каждого дилера — сохраняем прогресс
  ctx.HC.MAX_RUNTIME_MS = 45 * 60000;
  ctx.CAMPAIGN_MERGE.maxRunMs = 45 * 60000;
  // запись в медиаплан — сразу, внутри try кода Hub: ошибка записи идёт в «Журнал ошибок» дилера (E5), как в Apps Script
  const origWrite = ctx.writeBlocks;
  ctx.writeBlocks = function () { const r = origWrite.apply(this, arguments); flushMps(); return r; };
  const origMerge = ctx.mergeAdsDataSheet_;
  ctx.mergeAdsDataSheet_ = function () { const r = origMerge.apply(this, arguments); flushMps(); return r; };
  const origTokenFor = ctx.tokenFor;
  const ENV_KEY = { meta: 'META_TOKEN', tiktok: 'TIKTOK_TOKEN', yandex: 'YANDEX_TOKEN' };
  ctx.tokenFor = function (dealer, platform) {
    const own = String(dealer[platform + '_token_key'] || '').trim();
    if ((own && props[own]) || (!own && props[ENV_KEY[platform]])) return origTokenFor(dealer, platform);
    // свойства скрипта Apps Script сюда не переехали — токен кабинета из листа Total
    const t = tokenFor2(dealer, platform);
    if (t) return t;
    throw new Error('Нет токена ' + platform + ': в листе Total (All_Tokens) нет строки с этим кабинетом или Dealer_ID ' + dealer.dealer_id);
  };
  return { ctx, hub, flushHub, flushMps, mails, quota };
}

/**
 * Режим → что вызвать в коде Hub. Очередь (daily/monthly/custom/continue) крутится здесь, по дилеру за шаг.
 * @returns {{unfinished: number}} сколько дилеров осталось в очереди (не успели до deadline)
 */
export function runMode(env, { mode, months, dealers, log = console.log, deadline = Infinity }) {
  const { ctx, flushHub, flushMps } = env;
  const step = () => {
    try { flushMps(); } catch (e) { log('⚠️ Запись в медиаплан: ' + e.message); }
    try { flushHub(); } catch (e) { log('⚠️ Сохранение вкладок Hub: ' + e.message); }
  };
  const P = ctx.PropertiesService.getScriptProperties();
  const left = () => { try { return JSON.parse(P.getProperty(ctx.HUB.QUEUE_KEY) || '[]').length; } catch { return 0; } };
  const queue = (start) => {
    start();
    let guard = 0;
    while (left()) {
      step();
      if (Date.now() > deadline) { log(`⏱ Время задания на исходе — осталось ${left()} дилеров, продолжу новым запуском`); return { unfinished: left() }; }
      if (++guard > 5000) throw new Error('Очередь не уменьшается');
      ctx.hubProcessQueue();
    }
    step();
    return { unfinished: 0 };
  };
  if (mode === 'daily') return queue(() => ctx.startQueue_('daily'));
  if (mode === 'monthly-auto') return queue(() => ctx.hubMonthlyStart());
  if (mode === 'monthly') return queue(() => ctx.startQueue_('monthly'));
  if (mode === 'continue') return queue(() => { if (!left()) log('Очередь пуста — продолжать нечего'); });
  if (mode === 'custom') { if (!months) throw new Error('Укажите месяцы: 2026-05 или 2026-01..2026-07'); return queue(() => ctx.startQueue_('custom', ctx.parseMonthRange(months))); }
  if (mode === 'dealer') {
    const ids = String(dealers || '').split(/[,\s]+/).filter(Boolean);
    if (!ids.length) throw new Error('Укажите Dealer_ID');
    const periods = months ? ctx.parseMonthRange(months) : ctx.buildPeriods('daily');
    for (const id of ids) {
      const d = ctx.findDealer(id);
      if (!d) { log('❌ ' + id + ': нет в Registry'); ctx.logRow(id, '', 'ALL', 0, 0, 'ERROR дилер не найден в Registry'); continue; }
      const r = ctx.runDealer(d, periods);
      log((r.errors.length ? '⚠️ ' : '✅ ') + id + ': записано ' + (r.written.join(', ') || '—') + (r.errors.length ? '; ошибки: ' + r.errors.map((e) => e.platform + ': ' + e.message).join(' | ') : ''));
      step();
    }
    return { unfinished: 0 };
  }
  if (mode === 'check') { ctx.hcRun_(); step(); return { unfinished: 0 }; }
  if (mode === 'merge') { ctx.mergeDuplicatesAllMp(); step(); return { unfinished: 0 }; }
  if (mode === 'merge-preview') { ctx.previewDuplicatesAllMp(); step(); return { unfinished: 0 }; }
  throw new Error('Неизвестный режим ' + mode);
}

/* ---------------- запуск в GitHub Actions ---------------- */

/** Токен Google синхронно (код Hub синхронный): отдельный процесс, без кеша tokenProvider. */
function makeTokenGetter() {
  const lib = pathToFileURL(path.join(HERE, 'lib', 'google.mjs')).href;
  const fetchToken = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { tokenProvider } from ${JSON.stringify(lib)}; process.stdout.write(await tokenProvider(${JSON.stringify(SCOPES)})());`],
  { env: process.env, maxBuffer: 1024 * 1024 }).toString().trim();
  let token = ''; let at = 0;
  return (force) => {
    if (force || !token || Date.now() - at > 45 * 60000) { token = fetchToken(); at = Date.now(); }
    return token;
  };
}

async function redispatchContinue(say) {
  const repo = process.env.GITHUB_REPOSITORY; const gh = process.env.GITHUB_TOKEN;
  if (!repo || !gh) { say('⚠️ Не могу запустить продолжение: нет GITHUB_TOKEN — запустите Autoreport Hub в режиме continue вручную.'); return; }
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/hub.yml/dispatches`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + gh, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: process.env.GITHUB_REF_NAME || 'main', inputs: { mode: 'continue' } })
  });
  say(res.status === 204 ? '↻ Продолжение очереди запущено (режим continue).' : '⚠️ Продолжение не запустилось: HTTP ' + res.status + ' — запустите режим continue вручную.');
}

async function main() {
  const mode = String(process.env.HUB_MODE || 'daily').trim();
  const dry = process.env.HUB_DRY === '1';
  const started = Date.now();
  if (new Date(2026, 0, 1).getTimezoneOffset() !== -300) throw new Error('Запускайте с TZ=Asia/Almaty: даты Hub считаются по Алматы');
  const say = (s) => { console.log(s); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n'); };
  say(`# Autoreport Hub · ${mode}${dry ? ' · без записи' : ''}`);
  const getToken = makeTokenGetter();

  // 1. Вкладки Hub: из D1; если Registry ещё нет (первый запуск) или режим import — из старой таблицы Hub
  let sheets = loadHubSheets();
  if (mode === 'import' || (!sheets.has('Registry') && mode !== 'mirror')) {
    const g = openGoogleSpreadsheet(getToken, HUB_ID);
    const imported = new Map(g.getSheets().map((sh) => [sh.getName(), sh._grid()]));
    if (!imported.has('Registry')) throw new Error('В таблице Hub нет вкладки Registry — импортировать нечего');
    const props = sheets.get(PROPS_SHEET);
    d1ExecFile(saveSql(imported), 'hub-import');
    say(`Импорт из таблицы Hub в базу сайта: ${[...imported.keys()].join(', ')}`);
    sheets = imported; if (props) sheets.set(PROPS_SHEET, props);
  }
  if (!sheets.has('Registry')) throw new Error('В базе сайта ещё нет вкладок Hub — запустите режим import');

  let unfinished = 0;
  if (mode !== 'import' && mode !== 'mirror') {
    // 2. Токены: Total + секреты
    const total = await readSheet(() => getToken(), ALL_TOKENS_ID, 'Total');
    const props = Object.fromEntries((sheets.get(PROPS_SHEET) || []).filter((r) => r[0]).map((r) => [String(r[0]), String(r[1])]));
    const secrets = {
      GADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN, GADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID,
      GADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET, GADS_MCC_ID: GOOGLE_LOGIN_CUSTOMER_ID,
      GADS_REFRESH_TOKEN: (donorCandidates(total)[0] || {}).token,
      META_TOKEN: process.env.HUB_META_TOKEN, TIKTOK_TOKEN: process.env.HUB_TIKTOK_TOKEN, YANDEX_TOKEN: process.env.HUB_YANDEX_TOKEN,
      TELEGRAM_BOT_TOKEN: process.env.HUB_TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: process.env.HUB_TELEGRAM_CHAT_ID
    };
    const secretKeys = new Set(Object.keys(secrets));
    for (const [k, v] of Object.entries(secrets)) { delete props[k]; if (v) props[k] = String(v); }
    if (!secrets.GADS_DEVELOPER_TOKEN) say('⚠️ Нет секретов GOOGLE_ADS_* — Google Ads у всех дилеров уйдёт в «Журнал ошибок».');
    if (!secrets.TELEGRAM_BOT_TOKEN) say('ℹ️ Нет секрета HUB_TELEGRAM_BOT_TOKEN — сообщений в Telegram не будет (журнал ошибок пишется).');

    // 3. Код Hub
    const env = buildHub({
      sheets, props, secretKeys, getToken, dry, tokenFor2: totalTokens(total),
      saveHub: (m) => d1ExecFile(saveSql(m), 'hub-save')
    });
    try {
      ({ unfinished } = runMode(env, { mode, months: process.env.HUB_MONTHS, dealers: process.env.HUB_DEALERS, log: say, deadline: started + RUN_BUDGET_MS }));
    } finally {
      // Registry — с переносом только статусов поверх того, что сейчас на сайте
      const ran = env.hub.getSheetByName('Registry');
      if (ran && ran.dirty) ran.grid = mergeRegistryStatus(loadHubSheets(d1Query, 'Registry').get('Registry'), ran._grid());
      env.flushHub({ withRegistry: true });
      // лимит Google Ads исчерпан — сайт перезапустит Hub (daily), как только лимит обновится
      if (env.quota.length && !dry && ['daily', 'continue', 'monthly-auto', 'monthly', 'custom'].includes(mode)) {
        const resetAt = new Date(Math.max(...env.quota.map((q) => q.resetAt.getTime()))).toISOString();
        try {
          d1ExecFile(`INSERT INTO gads_exhausted (at, source, mode, reset_at, detail) VALUES (${sqlLiteral(new Date().toISOString())}, 'hub', ${sqlLiteral(mode)}, ${sqlLiteral(resetAt)}, ${sqlLiteral(env.quota.length + ' ответов 429; ' + (env.quota[0].rateName || 'дневной лимит'))});`, 'gads-exhausted');
          say(`⛔ Лимит Google Ads исчерпан (${env.quota.length} ответов 429). Сайт перезапустит Hub после ${resetAt}.`);
        } catch (e) { say('⚠️ Не записал исчерпание лимита в базу — автоперезапуска не будет: ' + e.message); }
      }
    }
    if (env.mails.length) say('\n## Письмо проверки (на сайте — вкладка «Проверка»)\n```\n' + env.mails.join('\n\n').slice(0, 6000) + '\n```');
    sheets = loadHubSheets();
  }

  // 4. Копия настроек в старую таблицу Hub — её читают ночная выгрузка, срез до Hub и недолёты
  if (dry) say('Без записи: старая таблица Hub не обновлялась.');
  else {
    const g = openGoogleSpreadsheet(getToken, HUB_ID);
    for (const n of EDITABLE) {
      const grid = sheets.get(n);
      if (!grid || !grid.length) continue;
      const sh = g.getSheetByName(n) || g.insertSheet(n);
      sh._grid(); // прежний размер листа — чтобы затереть его хвост
      sh.grid = grid.map((r) => r.slice()); sh.dirty = true;
      writeGoogleSheet(getToken, HUB_ID, sh, undefined, 'RAW');
    }
    say('Настройки скопированы в таблицу Hub: ' + EDITABLE.join(', '));
  }
  if (unfinished) await redispatchContinue(say);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('❌ ' + (e && e.stack || e)); process.exit(1); });
}
