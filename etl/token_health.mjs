#!/usr/bin/env node
// «Проверка токенов» (этап 5) — замена AUTH_Token_Health.gs (TH_RUN_1_CheckAllTokens, триггер 07:00).
// Читает токены из листа Total, проверяет каждый уникальный токен в Worker портала (там ключи приложений площадок;
// вход — OIDC-токен GitHub) и пишет итог: весь прогон — в лист Token_Health (как раньше) и в D1 (cc_dealers.health_*),
// прогон по отдельным дилерам (DEALERS) — только в D1, лист не трогается. Сам токен в отчёт не попадает — только отпечаток.

import fs from 'node:fs';
import { tokenProvider } from './lib/google.mjs';
import { ALL_TOKENS_ID, readSheet } from './lib/sheets.mjs';
import { d1ExecFile } from './lib/cloudflare.mjs';
import { buildInserts, sqlLiteral } from './lib/sql.mjs';
import { HEALTH_HEAD, healthRow } from './lib/token_check.mjs';
import { PLATFORMS, fingerprint } from './lib/portal.mjs';
import { portalCall, almatyStamp } from './portal_apply.mjs';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const BATCH = 25;
const summary = [];
const say = (s) => { console.log(s); summary.push(s); };

/** Лист Total → [{dealer, platform, token}] (строки одного дилера и одинаковые токены не схлопываются: отчёт — по связкам). */
export function tokenPairs(rows, only = []) {
  const head = (rows[0] || []).map((h) => String(h || '').trim());
  const c = head.indexOf('Distr_Dealer_ID');
  if (c === -1) throw new Error('В листе Total нет колонки Distr_Dealer_ID');
  const want = new Set(only.map((d) => d.toLowerCase()));
  const out = [];
  for (const r of rows.slice(1)) {
    const dealer = String((r || [])[c] || '').trim();
    if (!dealer || (want.size && !want.has(dealer.toLowerCase()))) continue;
    for (const p of PLATFORMS) {
      const i = head.indexOf(p + '_Token');
      const token = i > -1 ? String((r || [])[i] || '').trim() : '';
      if (token) out.push({ dealer, platform: p, token });
    }
  }
  return out;
}

async function main() {
  const only = String(process.env.DEALERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-tokens';
  const started = new Date().toISOString();
  d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'], [{ id: runId, kind: 'tokens', started, status: 'running' }]).join('\n'), 'tokens-start');
  let status = 'done';
  const detail = {};
  try {
    const token = tokenProvider(['https://www.googleapis.com/auth/spreadsheets']);
    const pairs = tokenPairs(await readSheet(token, ALL_TOKENS_ID, 'Total'), only);
    // Один и тот же токен у нескольких дилеров проверяется один раз.
    const uniq = new Map();
    for (const x of pairs) {
      const key = x.platform + '|' + (await fingerprint(x.token)) + '|' + x.token.length;
      x.key = key;
      if (!uniq.has(key)) uniq.set(key, x);
    }
    const keys = [...uniq.keys()];
    const results = {};
    for (let i = 0; i < keys.length; i += BATCH) {
      const part = keys.slice(i, i + BATCH);
      const r = await portalCall('/internal/check', { items: part.map((k) => ({ platform: uniq.get(k).platform, token: uniq.get(k).token })) });
      part.forEach((k, j) => { results[k] = r.results[j]; });
    }
    const checkedAt = new Date().toISOString();
    const stamp = almatyStamp(checkedAt);
    const counts = { OK: 0, EXPIRING: 0, INVALID: 0, ERROR: 0 };
    const rows = [];
    const problems = [];
    for (const x of pairs) {
      const r = results[x.key];
      counts[r.status] = (counts[r.status] || 0) + 1;
      rows.push(healthRow(stamp, x.dealer, x.platform, r, await fingerprint(x.token)));
      if (r.status === 'INVALID' || r.status === 'EXPIRING') problems.push(`${x.dealer} / ${x.platform}: ${r.status}${r.status === 'EXPIRING' && r.daysLeft !== null ? ` (осталось ${r.daysLeft} дн.)` : ''}${r.details ? ' — ' + r.details : ''}`);
    }

    if (!only.length) {
      // Весь лист заменяется, как thWriteReport_. Дата — текстом «дд.мм.гггг чч:мм:сс» (Алматы).
      const auth = { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' };
      const base = SHEETS_API + ALL_TOKENS_ID;
      const rng = encodeURIComponent("'Token_Health'");
      let res = await fetch(`${base}/values/${rng}:clear`, { method: 'POST', headers: auth, body: '{}' });
      if (!res.ok) throw new Error('Token_Health не очищен: HTTP ' + res.status + (res.status === 403 ? ' — нужна роль «Редактор» таблицы All_Tokens' : '') + (res.status === 400 ? ' — нет листа Token_Health' : ''));
      res = await fetch(`${base}/values/${encodeURIComponent("'Token_Health'!A1")}?valueInputOption=RAW`, { method: 'PUT', headers: auth, body: JSON.stringify({ values: [HEALTH_HEAD, ...rows] }) });
      if (!res.ok) throw new Error('Token_Health не записан: HTTP ' + res.status);
    }
    // D1: состояние токена у дилера × площадки (раздел «Здоровье токенов» и «Подключения» видят сразу).
    const sql = pairs.map((x, i) => {
      const r = results[x.key];
      const days = rows[i][4];
      return `UPDATE cc_dealers SET health_status = ${sqlLiteral(r.status)}, health_days = ${sqlLiteral(String(days))}, ` +
        `health_expires = ${sqlLiteral(r.expiresAt || '')}, health_checked = ${sqlLiteral(checkedAt)} ` +
        `WHERE lower(Dealer_ID) = lower(${sqlLiteral(x.dealer)}) AND Platform = ${sqlLiteral(x.platform)};`;
    });
    if (sql.length) d1ExecFile(sql.join('\n'), 'tokens-health');

    Object.assign(detail, { pairs: pairs.length, unique: keys.length, counts, problems: problems.slice(0, 100), dealers: only });
    say(`Проверено связок дилер×площадка: ${pairs.length} | уникальных токенов: ${keys.length}`);
    say(`✅ OK: ${counts.OK} | ⏳ истекают ≤14 дн.: ${counts.EXPIRING} | ❌ недействительны: ${counts.INVALID} | ⚠️ не проверены: ${counts.ERROR}`);
    for (const p of problems) say('  ' + p);
    if (counts.INVALID) status = 'failed';
  } catch (e) {
    status = 'failed';
    detail.error = String(e.message || e).slice(0, 1000);
    say('❌ ' + detail.error);
  }
  d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, detail = ${sqlLiteral(JSON.stringify(detail))} WHERE id = ${sqlLiteral(runId)};`, 'tokens-end');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  if (detail.error) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('token_health.mjs')) main();
