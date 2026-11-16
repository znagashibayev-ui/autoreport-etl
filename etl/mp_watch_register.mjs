#!/usr/bin/env node
// Подписка Google Drive на правки таблиц медиапланов: Google сам сообщает сайту (WATCH_URL, /hook/drive), что таблицу правили.
// Канал живёт сутки — задание запускается сайтом дважды в день и заменяет каналы новыми (старые останавливаются).
// Таблицы — все медиапланы из cc_mp_sheets (их читает пересчёт недолётов). Итог — etl_runs (kind = mp-watch-register).
// Окружение: WATCH_URL; GCP_WIF_PROVIDER + GCP_SERVICE_ACCOUNT (сервисный аккаунт — читатель таблиц); CLOUDFLARE_* (D1).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { tokenProvider } from './lib/google.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { buildInserts, sqlLiteral } from './lib/sql.mjs';
import { DRIVE_SCOPE } from './lib/mp_watch_io.mjs';

const DRIVE = 'https://www.googleapis.com/drive/v3/';
const TTL_MS = 23 * 3600000;
const out = [];
const say = (s) => { console.log(s); out.push(s); };

/** Понятное объяснение отказа Google. */
export function explainWatchError(status, body) {
  const msg = (body && body.error && body.error.message) || 'HTTP ' + status;
  if (/has not been used|is disabled|accessNotConfigured/i.test(msg)) return 'В проекте Google Cloud выключен Google Drive API — включите его (APIs & Services → Library → Google Drive API → Enable). ' + msg;
  if (/push.*webhook|domain|Unauthorized WebHook/i.test(msg)) return 'Google не принял адрес уведомлений сайта: ' + msg;
  if (status === 404) return 'Сервисному аккаунту не открыта таблица: ' + msg;
  return msg;
}

async function main() {
  const address = process.env.WATCH_URL;
  if (!/^https:\/\//.test(String(address))) throw new Error('Не задан WATCH_URL (https-адрес сайта + /hook/drive)');
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-mpwatch';
  d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'], [{ id: runId, kind: 'mp-watch-register', started: new Date().toISOString(), status: 'running' }]).join('\n'), 'mpw-start');
  const detail = { ok: 0, failed: [] };
  let status = 'done';
  try {
    const token = tokenProvider([DRIVE_SCOPE]);
    const since = new Date(Date.now() - 62 * 86400000).toISOString().slice(0, 7);
    const list = d1Query(`SELECT ss, GROUP_CONCAT(DISTINCT dealer) AS dealers FROM cc_mp_sheets WHERE month >= ${sqlLiteral(since)} AND error IS NULL AND ss IS NOT NULL GROUP BY ss`);
    const old = d1Query('SELECT id, resource_id, ss FROM cc_mp_watch');
    say(`# Подписка на правки медиапланов: таблиц ${list.length}, адрес ${address}`);
    const fresh = [];
    for (const t of list) {
      const id = crypto.randomUUID();
      const secret = crypto.randomBytes(24).toString('hex');
      const expires = Date.now() + TTL_MS;
      const res = await fetch(`${DRIVE}files/${t.ss}/watch?supportsAllDrives=true`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, type: 'web_hook', address, token: secret, expiration: String(expires) })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { detail.failed.push({ dealer: t.dealers, error: explainWatchError(res.status, body).slice(0, 300) }); continue; }
      fresh.push({ id, resource_id: body.resourceId || '', ss: t.ss, token: secret, expires: new Date(Number(body.expiration) || expires).toISOString(), created: new Date().toISOString() });
      detail.ok++;
    }
    if (fresh.length) d1ExecFile(buildInserts('cc_mp_watch', ['id', 'resource_id', 'ss', 'token', 'expires', 'created'], fresh).join('\n') + '\n', 'mpw-channels');
    // старые каналы тех же таблиц — остановить (иначе уведомление приходило бы дважды) и забыть
    const renewed = new Set(fresh.map((x) => x.ss));
    let stopped = 0;
    for (const o of old.filter((x) => renewed.has(x.ss))) {
      await fetch(DRIVE + 'channels/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: o.id, resourceId: o.resource_id }) }).catch(() => null);
      stopped++;
    }
    const drop = old.filter((x) => renewed.has(x.ss)).map((x) => sqlLiteral(x.id));
    if (drop.length) d1ExecFile(`DELETE FROM cc_mp_watch WHERE id IN (${drop.join(', ')});\n`, 'mpw-drop');
    d1ExecFile(`DELETE FROM cc_mp_watch WHERE expires < ${sqlLiteral(new Date().toISOString())};\n`, 'mpw-expired');
    say(`Подписано таблиц: ${detail.ok}, не получилось: ${detail.failed.length}, старых каналов остановлено: ${stopped}.`);
    for (const f of detail.failed) say(`- ${f.dealer}: ${f.error}`);
    if (detail.failed.length) status = 'failed';
  } catch (e) {
    status = 'failed';
    detail.error = String(e.message || e).slice(0, 1000);
    say('❌ ' + detail.error);
  }
  d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, detail = ${sqlLiteral(JSON.stringify(detail))} WHERE id = ${sqlLiteral(runId)};`, 'mpw-end');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
  if (status !== 'done') process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('mp_watch_register.mjs')) main().catch((e) => { console.error(e); process.exit(1); });
