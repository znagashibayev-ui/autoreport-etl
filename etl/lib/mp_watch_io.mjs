// Контроль медиаплана в заданиях (Node): кто и когда правил таблицу (Google Drive) и SQL записи снимка, журнала и утверждённого плана в D1.

import { sqlLiteral } from './sql.mjs';
import { CELLS_COLS, LOG_COLS } from './mp_watch.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const MAX_BYTES = 90000; // одно выражение D1 — до 100 КБ

/** Когда и кем таблица правилась последний раз. Ошибка (нет Drive API или доступа) — пусто: журнал пишется и без этого. */
export async function driveInfo(token, ss, fetchImpl = fetch) {
  try {
    const bearer = typeof token === 'function' ? await token() : token;
    const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${ss}?fields=modifiedTime,lastModifyingUser(displayName,emailAddress)&supportsAllDrives=true`,
      { headers: { Authorization: 'Bearer ' + bearer } });
    if (!res.ok) return { modified: null, who: null, error: 'HTTP ' + res.status };
    const j = await res.json();
    const u = j.lastModifyingUser || {};
    return { modified: j.modifiedTime || null, who: [u.displayName, u.emailAddress].filter(Boolean).join(' · ') || null };
  } catch (e) {
    return { modified: null, who: null, error: e.message };
  }
}

const bytes = (s) => Buffer.byteLength(String(s ?? ''));

/** Снимок не влезает в выражение D1 — числа округляются до копеек (изменения меньше 0,01 тогда не видны, что приемлемо). */
function fitCells(json) {
  if (bytes(json) <= MAX_BYTES) return json;
  const rounded = JSON.stringify(JSON.parse(json).map((r) => r.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))));
  return bytes(rounded) <= MAX_BYTES ? rounded : null;
}

function fitChanges(json) {
  let list = JSON.parse(json);
  while (list.length > 1 && bytes(JSON.stringify(list)) > MAX_BYTES - 4000) list = list.slice(0, Math.floor(list.length * 0.7));
  return JSON.stringify(list);
}

/** SQL: снимок (замена), утверждённый план (только если его ещё нет), журнал (если есть изменения). */
export function watchSql(rec) {
  const out = [];
  const c = { ...rec.cellsRow, cells: fitCells(rec.cellsRow.cells) };
  out.push(`INSERT OR REPLACE INTO cc_mp_cells (${CELLS_COLS.join(', ')}) VALUES (${CELLS_COLS.map((k) => sqlLiteral(c[k])).join(', ')});`);
  for (const b of rec.baseline) {
    out.push(`INSERT OR IGNORE INTO cc_mp_baseline (dealer, month, platform, plan, plan_gross, plan_kzt, set_at, set_by) VALUES (${
      [b.dealer, b.month, b.platform, b.plan, b.plan_gross, b.plan_kzt, b.set_at, b.set_by].map(sqlLiteral).join(', ')});`);
    // утверждения до 11.11.2026 без ₸ (столбец T): дописать ₸, если план S с тех пор не менялся
    if (b.plan_kzt !== null && b.plan_kzt !== undefined) {
      out.push(`UPDATE cc_mp_baseline SET plan_kzt = ${sqlLiteral(b.plan_kzt)} WHERE dealer = ${sqlLiteral(b.dealer)} AND month = ${sqlLiteral(b.month)} ` +
        `AND platform = ${sqlLiteral(b.platform)} AND plan_kzt IS NULL AND ABS(IFNULL(plan, 0) - ${sqlLiteral(b.plan || 0)}) < 0.01;`);
    }
  }
  if (rec.log) {
    const l = { ...rec.log, changes: fitChanges(rec.log.changes) };
    out.push(`INSERT INTO cc_mp_log (${LOG_COLS.join(', ')}) VALUES (${LOG_COLS.map((k) => sqlLiteral(l[k])).join(', ')});`);
  }
  return out.join('\n');
}
