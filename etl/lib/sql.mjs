// Сборка SQL-файлов для импорта в D1 (wrangler d1 execute --file).
// Значения встраиваются литералами, поэтому экранирование — главное место риска: проверено тестами.

// У D1 предел одного выражения — 100 КБ в БАЙТАХ (кириллица — 2 байта на букву). Берём с запасом.
const MAX_STATEMENT_BYTES = 60 * 1024;

/** SQL-литерал для SQLite/D1. */
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** Имя колонки/таблицы — только безопасные символы. */
export function ident(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Недопустимое имя: ' + name);
  return '"' + name + '"';
}

/**
 * INSERT ... VALUES пачками, каждая короче MAX_STATEMENT_BYTES.
 * @param {string} table
 * @param {string[]} columns
 * @param {object[]} rows
 * @returns {string[]} выражения
 */
export function buildInserts(table, columns, rows) {
  const head = `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES\n`;
  const headBytes = Buffer.byteLength(head);
  const out = [];
  let parts = [];
  let size = headBytes;
  for (const r of rows) {
    const tuple = '(' + columns.map((c) => sqlLiteral(r[c])).join(', ') + ')';
    const bytes = Buffer.byteLength(tuple) + 2;
    if (headBytes + bytes > MAX_STATEMENT_BYTES) throw new Error('Строка длиннее ' + MAX_STATEMENT_BYTES + ' байт — не помещается в одно выражение D1');
    if (parts.length && size + bytes > MAX_STATEMENT_BYTES) {
      out.push(head + parts.join(',\n') + ';');
      parts = [];
      size = headBytes;
    }
    parts.push(tuple);
    size += bytes;
  }
  if (parts.length) out.push(head + parts.join(',\n') + ';');
  return out;
}

/** Полная замена среза: DELETE по условию + INSERT. */
export function buildReplaceFile({ table, columns, rows, where }) {
  return [`DELETE FROM ${ident(table)} WHERE ${where};`, ...buildInserts(table, columns, rows)].join('\n') + '\n';
}

/** Месяцы 'YYYY-MM' от first до last включительно. */
export function monthsBetween(first, last) {
  const out = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
