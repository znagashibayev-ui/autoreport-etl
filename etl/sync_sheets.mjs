#!/usr/bin/env node
// Синхронизация таблицы All_Tokens ↔ D1 для админки (без Apps Script).
// 1) Правки доступа, сделанные на сайте (cc_access_changes, status = pending), записываются в лист Email_Access.
// 2) Листы Total, Email_Access, Token_Health, Access_Log, Onboarding_Audit копируются в D1 (cc_*), а доступы —
//    ещё и в dealer_email_access (его читает новый дашборд; так же делал Access_guard.gs для BigQuery).
// Пишется в таблицу только шаг 1 и только лист Email_Access. Итог — в etl_runs (kind = sync).
// Доступ: GCP_WIF_PROVIDER + GCP_SERVICE_ACCOUNT (для шага 1 у аккаунта должна быть роль «Редактор» таблицы);
// CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID — D1.

import { SHEETS_SCOPE, tokenProvider } from './lib/google.mjs';
import { ALL_TOKENS_ID, readSheet } from './lib/sheets.mjs';
import { buildInserts, sqlLiteral } from './lib/sql.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { PLATFORMS, parseDealers, parseEmailAccess, parseHealth, parseLogs, planAccessEdits } from './lib/admin_sheets.mjs';
import { MA_REGISTRY_ID, MA_TABS, parseRegistry } from './lib/multiaccount.mjs';

const SHEETS_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const EA = 'Email_Access';
const DEALER_COLS = ['Dealer_ID', 'Platform', 'Dealer_Type', 'has_token', 'account_id', 'keyword', 'goals',
  'health_status', 'health_days', 'health_expires', 'health_checked'];

async function readOptional(token, name, spreadsheet = ALL_TOKENS_ID) {
  try {
    return await readSheet(token, spreadsheet, name);
  } catch (err) {
    if (/Unable to parse range|not found/i.test(err.message)) return null; // листа нет — не ошибка
    throw err;
  }
}

/** Пары доступа + правки с сайта, которые ещё не дошли до таблицы (чтобы синхронизация их не откатила). */
export function withPending(pairs, pending) {
  let out = pairs.slice();
  for (const p of pending) {
    const email = String(p.email).toLowerCase();
    const same = (x) => x.Dealer_ID.toLowerCase() === String(p.dealer).toLowerCase() && x.Email === email;
    if (p.action === 'remove') out = out.filter((x) => !same(x));
    else if (!out.some(same)) out.push({ Dealer_ID: p.dealer, Email: email });
  }
  return out;
}

/** SQL-файл полной замены таблиц админки. dealer_email_access заменяется, только если доступы не пусты. */
export function buildSyncSql({ dealers, emails, logs }) {
  const access = emails.length
    ? ['DELETE FROM dealer_email_access;', ...buildInserts('dealer_email_access', ['Email', 'Distr_Dealer_ID'], emails.map((e) => ({ Email: e.Email, Distr_Dealer_ID: e.Dealer_ID })))]
    : [];
  return [
    'DELETE FROM cc_dealers;', ...buildInserts('cc_dealers', DEALER_COLS, dealers),
    'DELETE FROM cc_email_access;', ...buildInserts('cc_email_access', ['Dealer_ID', 'Email'], emails),
    ...access,
    'DELETE FROM cc_access_log;', ...buildInserts('cc_access_log', ['at', 'app', 'event', 'email', 'dealer', 'platform', 'detail'], logs)
  ].join('\n') + '\n';
}

async function sheetsCall(token, path, body) {
  const res = await fetch(SHEETS_API + ALL_TOKENS_ID + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (out.error && out.error.message) || 'HTTP ' + res.status;
    throw new Error(res.status === 403
      ? 'нет права записи в таблицу All_Tokens: откройте её аккаунту autoreport-github@astana-motors-accounts.iam.gserviceaccount.com с ролью «Редактор»'
      : 'Google Sheets: ' + msg);
  }
  return out;
}

/** Шаг 1: правки доступа с сайта → лист Email_Access. Возвращает число применённых правок. */
async function applyAccessChanges() {
  const pending = d1Query("SELECT id, email, dealer, action FROM cc_access_changes WHERE status = 'pending' ORDER BY id");
  if (!pending.length) return { applied: 0 };
  const now = () => new Date().toISOString();
  try {
    const token = tokenProvider([SHEETS_WRITE_SCOPE]);
    const rows = await readSheet(token, ALL_TOKENS_ID, EA);
    const plan = planAccessEdits(rows, pending);
    if (plan.updates.length) {
      await sheetsCall(token, '/values:batchUpdate', {
        valueInputOption: 'RAW', data: plan.updates.map((u) => ({ range: `'${EA}'!B${u.row}`, values: [[u.value]] }))
      });
    }
    if (plan.appends.length) {
      await sheetsCall(token, `/values/${encodeURIComponent(`'${EA}'!A:B`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: plan.appends });
    }
    d1ExecFile(plan.results.map((r) => `UPDATE cc_access_changes SET status = 'done', note = ${sqlLiteral(r.note)}, applied = ${sqlLiteral(now())} WHERE id = ${Number(r.id)};`).join('\n'), 'access-done');
    console.log(`Правок доступа записано в Email_Access: ${plan.results.length} (ячеек изменено ${plan.updates.length}, строк добавлено ${plan.appends.length})`);
    return { applied: plan.results.length };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 500);
    d1ExecFile(pending.map((p) => `UPDATE cc_access_changes SET status = 'failed', note = ${sqlLiteral(msg)}, applied = ${sqlLiteral(now())} WHERE id = ${Number(p.id)};`).join('\n'), 'access-failed');
    console.error('Правки доступа не записаны: ' + msg);
    return { applied: 0, accessError: msg };
  }
}

async function main() {
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-sync';
  const started = new Date().toISOString();
  d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'], [{ id: runId, kind: 'sync', started, status: 'running' }]).join('\n'), 'sync-start');
  let status = 'done';
  let detail = {};
  try {
    const access = await applyAccessChanges();
    const token = tokenProvider([SHEETS_SCOPE]);
    const [total, emails, health, log, onboarding] = await Promise.all([
      readSheet(token, ALL_TOKENS_ID, 'Total'), readOptional(token, EA), readOptional(token, 'Token_Health'),
      readOptional(token, 'Access_Log'), readOptional(token, 'Onboarding_Audit')
    ]);
    // Кабинеты из таблицы-реестра MultiAccount_Universal (несколько кабинетов у одного дилера). Нет доступа — не ошибка синхронизации.
    const registries = {};
    let registryError = '';
    for (const p of PLATFORMS) {
      try {
        const values = await readOptional(token, MA_TABS[p], MA_REGISTRY_ID);
        if (values) registries[p] = parseRegistry(values, p);
      } catch (err) {
        registryError = String(err.message || err).slice(0, 300);
      }
    }
    const pairs = parseEmailAccess(emails || []);
    const stillPending = d1Query("SELECT email, dealer, action FROM cc_access_changes WHERE status = 'pending' ORDER BY id");
    const data = {
      dealers: parseDealers(total, parseHealth(health || []), registries),
      emails: withPending(pairs, stillPending),
      logs: parseLogs(log || [], onboarding || [])
    };
    d1ExecFile(buildSyncSql(data), 'sync');
    const dealerIds = new Set(data.dealers.map((d) => d.Dealer_ID));
    detail = { dealers: dealerIds.size, accounts: data.dealers.filter((d) => d.has_token).length, emails: data.emails.length, logs: data.logs.length,
      rows: data.dealers.length + data.emails.length + data.logs.length, accessApplied: access.applied, badEmails: pairs.bad.slice(0, 20),
      registry: Object.keys(registries).map((p) => p + ': ' + Object.keys(registries[p]).length).join(', '), registryError,
      missing: [!emails && EA, !health && 'Token_Health', !log && 'Access_Log', !onboarding && 'Onboarding_Audit'].filter(Boolean) };
    if (access.accessError) {
      status = 'failed';
      detail.error = 'Правки доступа не записаны в таблицу: ' + access.accessError;
    }
    console.log(`Дилеров: ${detail.dealers}, кабинетов с токеном: ${detail.accounts}, доступов: ${detail.emails}, записей журнала: ${detail.logs}`);
  } catch (err) {
    status = 'failed';
    detail = { error: String(err.message || err).slice(0, 2000) };
    console.error(err);
  }
  d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, ` +
    `detail = ${sqlLiteral(JSON.stringify(detail))} WHERE id = ${sqlLiteral(runId)};`, 'sync-end');
  if (status !== 'done') process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('sync_sheets.mjs')) main();
