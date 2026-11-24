// Самопроверка «Autoreport Hub на сайте» без сети: настоящий код Hub (etl/hub/*.gs) + переходник, ответы API и таблиц подменены.
// Запуск: TZ=Asia/Almaty node etl/hub_selftest.mjs
import assert from 'node:assert/strict';
import { buildHub, runMode, mergeRegistryStatus, saveSql, totalTokens, nextPacificMidnight, quotaInfo } from './hub_run.mjs';
import { chunks, formatDate, parseDateCell, serialToDate, fromJsonGrid, toJsonGrid } from './lib/gas.mjs';

assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), -300, 'запускайте с TZ=Asia/Almaty');

// --- даты ---
const d = parseDateCell('23.11.2026');
assert.equal(d.getDate(), 23); assert.equal(d.getMonth(), 10); assert.equal(formatDate(d, 'Asia/Almaty', 'dd.MM.yyyy'), '23.11.2026');
assert.equal(formatDate(parseDateCell('24.11.2026 7:04:05'), 'Asia/Almaty', 'dd.MM.yyyy HH:mm'), '24.11.2026 07:04');
assert.equal(parseDateCell('meta_perf_x'), null);
assert.deepEqual(fromJsonGrid(JSON.parse(JSON.stringify(toJsonGrid([[d, 'a', 1]]))))[0][0].getTime(), d.getTime());
assert.equal(formatDate(serialToDate(46348), 'Asia/Almaty', 'dd.MM.yyyy'), '22.11.2026');
assert.equal(formatDate(serialToDate(46348.25), 'Asia/Almaty', 'dd.MM.yyyy HH:mm'), '22.11.2026 06:00');
assert.deepEqual(chunks('ab\u{1F50E}cd', 3), ['ab', '\u{1F50E}c', 'd'], 'эмодзи не режется');

// --- таблицы ---
const MP = '1Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const mpValues = [
  ['Дата', 'Кампания', 'Показы', 'Охват', 'Клики', 'Конверсии', 'Расход'],
  [], [],
  ['месяц Октябрь'],
  ['31.10.2026', 'meta_perf_old', 10, 5, 1, 1, 9.5],
  [], [],
  ['месяц Ноябрь'],
  ['22.11.2026', 'meta_perf_x', 1000, 800, 20, 3, 55.25],
  ['22.11.2026', 'tt_old', 50, 40, 2, 0, 4],
  [], [], ['', '', '', '', '', '', '', 'заметка в H'] // хвост: должен затереться пустыми ячейками
];
// Sheets API: ячейка-дата при SERIAL_NUMBER — число, при FORMATTED_STRING — текст
const toSerial = (v) => { const m = /^(\d\d)\.(\d\d)\.(\d{4})$/.exec(v); return m ? (Date.UTC(+m[3], +m[2] - 1, +m[1]) - Date.UTC(1899, 11, 30)) / 864e5 : v; };
const writes = [];
let failWrite = false;
const http = (url, o) => {
  if (url.includes('business-api.tiktok.com')) {
    return { code: 200, headers: {}, text: JSON.stringify({ code: 0, data: { page_info: { total_page: 1 }, list: [
      { metrics: { campaign_name: 'tt_new', spend: '12.5', impressions: '100', clicks: '7', engagements: '0', reach: '90', conversion: '1.2' } }] } }) };
  }
  if (url.includes('graph.facebook.com')) return { code: 400, headers: {}, text: JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }) };
  if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/' + MP)) {
    if (o.method === 'GET' && url.includes('fields=')) return { code: 200, headers: {}, text: JSON.stringify({ properties: { title: 'MP test' }, sheets: [{ properties: { title: 'Ads Data', sheetId: 7, gridProperties: { rowCount: 1000, columnCount: 26 } } }] }) };
    if (o.method === 'GET') {
      const serial = url.includes('SERIAL_NUMBER');
      return { code: 200, headers: {}, text: JSON.stringify({ values: mpValues.map((r) => r.map((v) => (serial ? toSerial(v) : v))) }) };
    }
    if (failWrite) return { code: 403, headers: {}, text: JSON.stringify({ error: { message: 'The caller does not have permission' } }) };
    writes.push({ method: o.method, url, body: o.body ? JSON.parse(o.body) : null });
    return { code: 200, headers: {}, text: '{}' };
  }
  throw new Error('Неожиданный запрос ' + url);
};
const registry = [
  ['dealer_id', 'brand', 'active', 'mp_spreadsheet_id', 'mp_sheet_name', 'google_customer_id', 'google_conv_include', 'google_conv_exclude',
    'meta_act_ids', 'meta_token_key', 'tiktok_adv_ids', 'tiktok_token_key', 'yandex_client_login', 'yandex_goal_ids', 'yandex_token_key', 'last_run', 'last_status'],
  ['Dealer_Test', 'Test', true, MP, 'Ads Data', '', '', '', '222', '', '111', 'TIKTOK_TOKEN_OLD', '', '', '', '', ''],
  ['Dealer_Off', 'Off', false, MP, 'Ads Data', '', '', '', '', '', '', '', '', '', '', '', '']
];
const total = [['Dealer_ID', 'Meta_Token', 'Meta_Ad_Account_ID', 'TikTok_Token', 'TikTok_Advertiser_ID'], ['Other', 'mt', 'act_222', 'tt', '111']];
const tok = totalTokens(total);
assert.equal(tok({ dealer_id: 'Dealer_Test', meta_act_ids: '222' }, 'meta'), 'mt');
assert.equal(tok({ dealer_id: 'Other', tiktok_adv_ids: '999' }, 'tiktok'), 'tt');
assert.equal(tok({ dealer_id: 'Nobody', tiktok_adv_ids: '999' }, 'tiktok'), '');

function makeEnv() {
  const saved = [];
  const sheets = new Map([['Registry', registry.map((r) => r.slice())], ['Mapping', [['Старое название', 'Новое название', 'Аккаунт']]],
    ['Config', [['Параметр', 'Значение'], ['MIN_IMPRESSIONS', 1]]], ['Overrides', [['dealer_id', 'platform', 'campaign', 'date_from', 'date_to', 'conversions', 'comment']]]]);
  const env = buildHub({ sheets, props: {}, secretKeys: new Set(), tokenFor2: tok, getToken: () => 'x', http, log: () => {}, saveHub: (m) => saved.push(m) });
  return { env, saved };
}
const merged = (saved) => Object.assign({}, ...saved.map((m) => Object.fromEntries(m)));

// --- один дилер за ноябрь: TikTok свежий (ключ токена из Registry, которого нет в свойствах → Total), Meta упала → E2 ---
{
  writes.length = 0;
  const { env, saved } = makeEnv();
  runMode(env, { mode: 'dealer', dealers: 'Dealer_Test', months: '2026-11', log: () => {} });
  const puts = writes.filter((w) => w.method === 'PUT');
  assert.ok(!writes.some((w) => w.url.includes(':clear')), 'без отдельной очистки: сбой не оставит лист пустым');
  assert.equal(puts.length, 1, 'одна запись листа');
  assert.ok(puts[0].url.includes('valueInputOption=USER_ENTERED'));
  const v = puts[0].body.values;
  assert.ok(v.length >= mpValues.length && v.every((r) => r.length === 8), 'запись покрывает прежний размер листа');
  assert.ok(v.every((r) => r[7] === ''), 'хвост прежних данных затёрт');
  assert.deepEqual(v[0].slice(0, 7), ['Дата', 'Кампания', 'Показы', 'Охват', 'Клики', 'Конверсии', 'Расход']);
  const iOct = v.findIndex((r) => r[0] === 'месяц Октябрь'); const iNov = v.findIndex((r) => r[0] === 'месяц Ноябрь');
  assert.deepEqual(v[iOct + 1].slice(0, 7), ['31.10.2026', 'meta_perf_old', 10, 5, 1, 1, 9.5], 'другой месяц не тронут, дата осталась датой');
  const nov = v.slice(iNov + 1).filter((r) => r.join('') !== '').map((r) => r.slice(0, 7));
  assert.deepEqual(nov.find((r) => r[1] === 'tt_new'), ['30.11.2026', 'tt_new', 100, 90, 7, 2, 12.5], 'TikTok: ceil конверсий, дата — конец периода');
  assert.deepEqual(nov.find((r) => r[1] === 'meta_perf_x'), ['22.11.2026', 'meta_perf_x', 1000, 800, 20, 3, 55.25], 'Meta упала — строка из МП сохранена');
  assert.ok(nov.find((r) => r[1] === 'tt_old'), 'как в Hub (E2): при упавшей площадке остаются все строки МП, которых нет среди свежих');
  env.flushHub({ withRegistry: true });
  const all = merged(saved);
  const reg = all.Registry; const st = reg[0].indexOf('last_status');
  assert.match(String(reg[1][st]), /^ERROR Meta/, 'статус дилера в Registry');
  assert.equal(all['Журнал ошибок'].length, 2, 'строка в журнале ошибок');
  assert.ok(all.Log.some((r) => r[3] === 'TikTok' && r[6] === 'OK'), 'Log');
}

// --- нет доступа на запись к МП: ошибка дилера в журнале (E5), запуск не падает ---
{
  failWrite = true;
  const { env, saved } = makeEnv();
  runMode(env, { mode: 'daily', log: () => {} });
  failWrite = false;
  env.flushHub({ withRegistry: true });
  const all = merged(saved);
  assert.ok(all['Журнал ошибок'].some((r) => r[4] === 'Запись в МП'), 'ошибка записи — в журнале');
  assert.ok(all.Log.some((r) => r[3] === 'ЗАПИСЬ' && /^ERROR/.test(r[6])), 'Log: ЗАПИСЬ ERROR');
  assert.equal(Object.fromEntries(all['Статус'].map((r) => [r[0], r[1]]))['Сейчас'], '✅ завершено', 'очередь дошла до конца');
}

// --- очередь «ежедневно»: только активные дилеры; остановка по времени оставляет очередь для continue ---
{
  const { env, saved } = makeEnv();
  runMode(env, { mode: 'daily', log: () => {} });
  const status = Object.fromEntries(merged(saved)['Статус'].map((r) => [r[0], r[1]]));
  assert.equal(status['Сейчас'], '✅ завершено'); assert.equal(status['Всего дилеров'], 1); assert.equal(status['Готово'], 1);
  const late = makeEnv();
  late.env.ctx.HUB.MAX_RUN_MS = -1; // шаг очереди ничего не обрабатывает — дилер остаётся в очереди
  assert.equal(runMode(late.env, { mode: 'daily', log: () => {}, deadline: 0 }).unfinished, 1);
  late.env.ctx.HUB.MAX_RUN_MS = 1;
  assert.equal(runMode(late.env, { mode: 'continue', log: () => {} }).unfinished, 0, 'continue доделывает очередь');
}

// --- проверка и склейка (предпросмотр) проходят без ошибок ---
{
  const { env, saved } = makeEnv();
  runMode(env, { mode: 'check', log: () => {} });
  assert.ok(String(merged(saved)['Проверка'][0][0]).startsWith('Проверка за'), 'вкладка «Проверка»');
  writes.length = 0;
  runMode(env, { mode: 'merge-preview', log: () => {} });
  assert.equal(writes.length, 0, 'предпросмотр склейки ничего не пишет в МП');
}

// --- Registry: статусы запуска поверх правок сайта ---
const cur = [['dealer_id', 'brand', 'last_run', 'last_status'], ['A', 'новое имя', '', ''], ['B', 'b', 'x', 'OK']];
const ran = [['dealer_id', 'brand', 'last_run', 'last_status'], ['a', 'старое', 'r1', 'ERROR x'], ['B', 'b', '', '']];
assert.deepEqual(mergeRegistryStatus(cur, ran), [['dealer_id', 'brand', 'last_run', 'last_status'], ['A', 'новое имя', 'r1', 'ERROR x'], ['B', 'b', 'x', 'OK']]);

// --- D1: части не длиннее предела выражения ---
const big = Array.from({ length: 6000 }, (_, i) => ['Время ' + i, 'Дилер_кириллица_' + i, 'месяц Ноябрь', 'Meta', 5, 123.45, 'OK ' + 'ж'.repeat(40)]);
const sql = saveSql(new Map([['Log', big]]));
for (const s of sql.split('\n')) assert.ok(Buffer.byteLength(s) < 100000, 'выражение D1 < 100 КБ');
const parts = sql.split('\n').filter((s) => s.startsWith('INSERT')).map((s) => s.match(/, \d+, '(.*)', '[^']*'\);$/)[1].replace(/''/g, "'"));
assert.deepEqual(JSON.parse(parts.join('')).length, 6000, 'части склеиваются обратно');

// --- лимит Google Ads: когда обновится ---
{
  const now = new Date('2026-11-24T02:00:00Z'); // 07:00 Алматы = 18:00 23.11 в Лос-Анджелесе (PST, UTC−8)
  assert.equal(nextPacificMidnight(now).toISOString(), '2026-11-24T08:00:00.000Z', 'полночь PST = 13:00 Алматы');
  assert.equal(nextPacificMidnight(new Date('2026-07-01T02:00:00Z')).toISOString(), '2026-07-01T07:00:00.000Z', 'летом PDT, UTC−7');
  const body = '[{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"errors":[{"errorCode":{"quotaError":"RESOURCE_EXHAUSTED"},"details":{"quotaErrorDetails":{"rateScope":"DEVELOPER","rateName":"Number of operations for basic access per day","retryDelay":"21600s"}}}]}]}}]';
  const q = quotaInfo(body, now);
  assert.equal(q.resetAt.toISOString(), '2026-11-24T08:00:00.000Z'); assert.match(q.rateName, /per day/);
  assert.equal(quotaInfo('{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"30s"}]}}', now), null, 'короткая пауза — не дневной лимит');
  assert.equal(quotaInfo('Resource has been exhausted (e.g. check quota). RESOURCE_EXHAUSTED', now).resetAt.toISOString(), '2026-11-24T08:00:00.000Z', 'без retryDelay — полночь PST');
}

console.log('✅ hub_selftest: все проверки пройдены');
