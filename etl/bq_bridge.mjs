#!/usr/bin/env node
// Ежедневная копия BigQuery → D1, пока Apps Script ещё грузит площадки, которые GitHub сам в D1 не пишет.
// Копируются только площадки без полной ночной записи GitHub за последние 3 дня (сейчас Meta, Google Ads, TikTok; Яндекс — нет).
// Не перезаписывается то, что GitHub загрузил прямо из кабинетов (таблица cc_restored: «Восстановить», первая загрузка портала).
// BigQuery только читается. Окружение: MONTHS — «2026-11» | «2026-07..2026-11» | пусто (текущий и до 10-го числа прошлый).

import { ETL_SCOPES, bqSelect, tokenProvider } from './lib/google.mjs';
import { buildInserts, monthRange, monthsBetween, sqlLiteral } from './lib/sql.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { runProgress } from './lib/progress.mjs';

const STEPS = {
  check: [0, 4, 'Проверяем, какие площадки GitHub уже пишет сам'],
  read: [4, 60, 'Читаем BigQuery по месяцам'],
  write: [60, 100, 'Записываем в D1 (кроме восстановленного из кабинетов)']
};
import { DAILY_COLUMNS } from './migrate_bq.mjs';
import { defaultMonths } from './gaps.mjs';

const KIND = { Meta: 'etl:meta', 'Google Ads': 'etl:google', TikTok: 'etl:tiktok', Yandex: 'etl:yandex' };
const MIGRATED_DAYS = 3;

export function parseBridgeMonths(raw, now) {
  const s = String(raw || '').trim();
  if (!s) return defaultMonths(now);
  const m = s.match(/^(20\d\d-\d\d)(?:\.\.(20\d\d-\d\d))?$/);
  if (!m) throw new Error('Неверные месяцы: ' + s + ' (пример: 2026-11 или 2026-07..2026-11)');
  return monthsBetween(m[1], m[2] || m[1]);
}

/** Строка BigQuery защищена, если её дилер × площадка × дата уже загружены GitHub из кабинета. */
export function isProtected(row, restored) {
  const d = String(row.Dealer_ID || '').toLowerCase();
  return restored.some((r) => r.dealer.toLowerCase() === d && r.platform === row.Platform && row.Date >= r.date_from && row.Date <= r.date_to);
}

async function main() {
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-bridge';
  d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'], [{ id: runId, kind: 'bridge', started: new Date().toISOString(), status: 'running' }]).join('\n'), 'bridge-start');
  let status = 'done';
  let detail = {};
  const prog = runProgress(runId, STEPS);
  try {
    const months = parseBridgeMonths(process.env.MONTHS);
    prog.phase('check', months.join(', '));
    prog.source('D1 → etl_runs, cc_restored', true);
    const since = new Date(Date.now() - MIGRATED_DAYS * 86400000).toISOString();
    const full = d1Query(`SELECT DISTINCT kind FROM etl_runs WHERE status = 'done' AND finished >= ${sqlLiteral(since)} AND detail NOT LIKE '%"subset":1%'`).map((r) => r.kind);
    const platforms = Object.keys(KIND).filter((p) => !full.includes(KIND[p]));
    const skipped = Object.keys(KIND).filter((p) => !platforms.includes(p));
    const restored = d1Query('SELECT dealer, platform, date_from, date_to FROM cc_restored');
    detail = { months, platforms, skipped, copied: 0, protected: 0 };
    console.log(`Копирую из BigQuery: ${platforms.join(', ') || 'нечего'}. GitHub пишет сам: ${skipped.join(', ') || '—'}. Защищённых диапазонов: ${restored.length}.`);
    if (platforms.length) {
      const token = tokenProvider(ETL_SCOPES);
      const inList = platforms.map(sqlLiteral).join(', ');
      for (const month of months) {
        const { from, to } = monthRange(month);
        prog.phase('read', month + ' · ' + platforms.join(', '));
        prog.source(`BigQuery → marketing_data.daily_statistics · ${from} — ${to}`, true);
        const cols = DAILY_COLUMNS.map((c) => (c === 'Date' ? 'CAST(Date AS STRING) AS Date' : c)).join(', ');
        const { rows } = await bqSelect(await token(), { project: 'astana-motors-accounts', location: 'EU',
          sql: `SELECT ${cols} FROM \`astana-motors-accounts.marketing_data.daily_statistics\` WHERE Date BETWEEN '${from}' AND '${to}' AND Platform IN (${inList})` });
        prog.rows(rows.length);
        const keep = rows.filter((r) => !isProtected(r, restored));
        prog.phase('write', month);
        prog.source(`D1 → daily_statistics · ${month}: ${keep.length} строк, не тронуто ${rows.length - keep.length}`, true);
        prog.rows(keep.length);
        detail.protected += rows.length - keep.length;
        detail.copied += keep.length;
        // заменяются только дилеры, которые есть в BigQuery: строки, которых там нет (Haval/Tank из fb-leads-haval), не стираются
        const bqDealers = [...new Set(rows.map((r) => String(r.Dealer_ID || '').toLowerCase()).filter(Boolean))];
        if (!bqDealers.length) { console.log(`${month}: в BigQuery строк нет — D1 не тронут`); continue; }
        d1ExecFile([
          `DELETE FROM daily_statistics WHERE Date BETWEEN ${sqlLiteral(from)} AND ${sqlLiteral(to)} AND Platform IN (${inList}) ` +
            `AND LOWER(Dealer_ID) IN (${bqDealers.map(sqlLiteral).join(', ')}) AND NOT EXISTS ` +
            '(SELECT 1 FROM cc_restored r WHERE LOWER(r.dealer) = LOWER(daily_statistics.Dealer_ID) AND r.platform = daily_statistics.Platform ' +
            'AND daily_statistics.Date BETWEEN r.date_from AND r.date_to);',
          ...buildInserts('daily_statistics', DAILY_COLUMNS, keep)
        ].join('\n') + '\n', 'bridge-' + month);
        console.log(`${month}: скопировано строк ${keep.length}, не тронуто (загружено из кабинетов) ${rows.length - keep.length}`);
      }
    }
  } catch (err) {
    status = 'failed';
    detail.error = String(err.message || err).slice(0, 2000);
    console.error(err);
  }
  d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, ` +
    `detail = ${sqlLiteral(JSON.stringify(detail))} WHERE id = ${sqlLiteral(runId)};`, 'bridge-end');
  if (status !== 'done') process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('bq_bridge.mjs')) main();
