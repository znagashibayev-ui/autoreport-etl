// Работа с D1 и R2 через wrangler (в GitHub Actions — по CLOUDFLARE_API_TOKEN, локально — по wrangler login).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const D1_DB = 'autoreport';
export const R2_BUCKET = 'autoreport-data';

// wrangler запускается напрямую через node (без оболочки): на Windows оболочка разбивает
// SQL-запрос по пробелам, а аргументы с кириллицей и кавычками должны уходить как есть.
const WRANGLER_JS = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function wrangler(args, { input } = {}) {
  const r = spawnSync(process.execPath, [decodeURIComponent(WRANGLER_JS), ...args], {
    encoding: 'utf8', input,
    maxBuffer: 512 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
  });
  if (r.status !== 0) {
    const msg = (r.stderr || '') + (r.stdout || '');
    throw new Error('wrangler ' + args.slice(0, 3).join(' ') + ' — ошибка:\n' + msg.trim().slice(-2000));
  }
  return r.stdout;
}

/** Выполнить SQL-файл в удалённой базе D1. */
export function d1ExecFile(sqlText, label = 'import') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-'));
  const file = path.join(dir, label.replace(/[^\w.-]/g, '_') + '.sql');
  fs.writeFileSync(file, sqlText);
  try {
    wrangler(['d1', 'execute', D1_DB, '--remote', '--yes', '--file', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** SELECT в D1, результат — массив строк-объектов. */
export function d1Query(sql) {
  const out = wrangler(['d1', 'execute', D1_DB, '--remote', '--json', '--command', sql]);
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success === false) throw new Error('D1: запрос не выполнен');
  return first.results || [];
}

/** Положить файл в R2. */
export function r2Put(key, file, contentType = 'application/octet-stream') {
  wrangler(['r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--remote', '--file', file, '--content-type', contentType]);
}

/** Скачать файл из R2 (для проверок того, что реально лежит в хранилище). */
export function r2Get(key, file) {
  wrangler(['r2', 'object', 'get', `${R2_BUCKET}/${key}`, '--remote', '--file', file]);
}
