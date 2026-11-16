#!/usr/bin/env node
// Пересчёт недолётов: медиапланы (лист «Ads Data» каждого дилера из Registry Autoreport Hub) против D1 → таблица cc_gaps.
// Таблицы только читаются. Итог — etl_runs (kind = gaps). Показывает админка, раздел «Недолёты».
// Окружение: MONTHS — «2026-11» или «2026-10,2026-11» (пусто = текущий месяц и, до 10-го числа, прошлый);
//            DEALERS — только эти Dealer_ID через запятую (пусто = все из Registry).
// Доступ: GCP_WIF_PROVIDER + GCP_SERVICE_ACCOUNT (чтение таблиц), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (D1).

import { SHEETS_SCOPE, tokenProvider } from './lib/google.mjs';
import { readSheet } from './lib/sheets.mjs';
import { buildInserts, monthRange, sqlLiteral } from './lib/sql.mjs';
import { d1ExecFile, d1Query } from './lib/cloudflare.mjs';
import { HUB_ID } from './platforms/googleads.mjs';
import { parseAds, parseAdsRegistry, parseMapping } from './lib/hubcap.mjs';
import { buildCabinetGaps, buildGaps, groupOf, registryTitles } from './lib/gaps.mjs';
import { parseMonthSheet, sheetName } from './lib/mediaplan.mjs';
import { TEAM_ID, TEAM_SHEET, cellUrl, matchTeam, parseTeam } from './lib/team.mjs';
import { runProgress } from './lib/progress.mjs';
import { auditRegistryIds } from './lib/dealer_ids.mjs';
import { watchRecords } from './lib/mp_watch.mjs';
import { DRIVE_SCOPE, driveInfo, watchSql } from './lib/mp_watch_io.mjs';

const STEPS = {
  registry: [0, 5, 'Читаем Registry, Mapping и «Проекты команды»'],
  ads: [5, 45, 'Читаем листы «Ads Data» медиапланов'],
  months: [45, 80, 'Читаем листы месяцев медиапланов'],
  compare: [80, 92, 'Сверяем базу D1 с кабинетами площадок'],
  write: [92, 100, 'Записываем недолёты и медиапланы в D1']
};

const MP_COLS = ['dealer', 'month', 'ss', 'sheet', 'meta', 'rows', 'ads', 'error', 'checked'];

const COLS = ['month', 'dealer', 'title', 'grp', 'platform', 'ads_conv', 'd1_conv', 'gap', 'ads_spend', 'd1_spend', 'spend_cur', 'spend_ok',
  'no_hub', 'ads_date', 'cap_date', 'camps', 'error', 'checked', 'cab_at', 'stale'];
const PARALLEL = 4; // медиапланов читается одновременно (квота чтения Google Sheets — 300 в минуту)

/** Месяцы по умолчанию (время Алматы): текущий и до 10-го числа — прошлый. */
export function defaultMonths(now = new Date()) {
  const t = new Date(now.getTime() + 5 * 3600000);
  const cur = t.toISOString().slice(0, 7);
  if (t.getUTCDate() > 10) return [cur];
  const p = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  return [p, cur];
}

export function parseMonths(raw, now) {
  const list = String(raw || '').split(/[,\s]+/).filter(Boolean);
  if (!list.length) return defaultMonths(now);
  for (const m of list) if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(m)) throw new Error('Неверный месяц: ' + m);
  return [...new Set(list)].sort();
}

/** Строки D1 за месяц → { dealer в нижнем регистре: [{Platform, Date, c, cv, usd, kzt}] } (как hcBqDaily_). */
function d1Month(month, dealers) {
  const { from, to } = monthRange(month);
  const only = dealers.length ? ` AND LOWER(Dealer_ID) IN (${dealers.map((d) => sqlLiteral(d.toLowerCase())).join(', ')})` : '';
  const rows = d1Query(`SELECT LOWER(Dealer_ID) AS d, Platform, Date, LOWER(IFNULL(Campaign_Name, '')) AS c, SUM(IFNULL(Conversions, 0)) AS cv, ` +
    `SUM(IFNULL(Spend_USD, 0)) AS usd, SUM(IFNULL(Spend_KZT, 0)) AS kzt FROM daily_statistics WHERE Date BETWEEN '${from}' AND '${to}'${only} ` +
    `GROUP BY 1, 2, 3, 4 HAVING cv != 0 OR usd != 0 OR kzt != 0`);
  const out = {};
  for (const r of rows) {
    // одна корзина на «дата × кампания без _another», как REGEXP_REPLACE в hcBqDaily_
    const c = String(r.c).replace(/_another$/, '');
    (out[r.d] = out[r.d] || []).push({ Platform: r.Platform, Date: r.Date, c, cv: Number(r.cv) || 0, usd: Number(r.usd) || 0, kzt: Number(r.kzt) || 0 });
  }
  return out;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function main() {
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-gaps';
  const started = new Date().toISOString();
  d1ExecFile(buildInserts('etl_runs', ['id', 'kind', 'started', 'status'], [{ id: runId, kind: 'gaps', started, status: 'running' }]).join('\n'), 'gaps-start');
  let status = 'done';
  let detail = {};
  const prog = runProgress(runId, STEPS);
  try {
    const months = parseMonths(process.env.MONTHS);
    prog.phase('registry', months.join(', '));
    prog.source('Autoreport Hub → лист Registry', true);
    const only = String(process.env.DEALERS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const token = tokenProvider([SHEETS_SCOPE, DRIVE_SCOPE]);
    const regValues = await readSheet(token, HUB_ID, 'Registry');
    const titles = registryTitles(regValues);
    // «Проекты команды» → какие медиапланы подсвечивать; ошибка здесь не мешает недолётам
    try {
      const teamValues = await readSheet(token, TEAM_ID, TEAM_SHEET);
      const linkRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${TEAM_ID}?ranges=${encodeURIComponent(TEAM_SHEET + '!A1:Z300')}` +
        '&fields=sheets(data(rowData(values(hyperlink,chipRuns,textFormatRuns(format(link))))))', { headers: { Authorization: 'Bearer ' + (await token()) } });
      const linkBody = await linkRes.json();
      if (!linkRes.ok) throw new Error((linkBody.error && linkBody.error.message) || 'HTTP ' + linkRes.status);
      const head = (teamValues[0] || []).map((x) => String(x).trim().toLowerCase());
      const mpCol = head.indexOf('ссылка на мп');
      const rowData = (((linkBody.sheets || [])[0] || {}).data || [])[0]?.rowData || [];
      const links = rowData.map((r) => cellUrl(((r && r.values) || [])[mpCol]));
      const team = matchTeam(parseTeam(teamValues, links), regValues);
      d1ExecFile(`INSERT OR REPLACE INTO cc_settings (key, value, updated) VALUES ('mp.team', ${sqlLiteral(JSON.stringify(team))}, ${sqlLiteral(new Date().toISOString())});`, 'team');
      console.log(`Проекты команды: ${Object.keys(team.byDealer).length} найдено в Registry` + (team.unmatched.length ? `, не найдены: ${team.unmatched.join(', ')}` : ''));
    } catch (e) {
      console.log('⚠️ «Проекты команды» не прочитаны: ' + e.message);
    }
    const mapping = parseMapping(await readSheet(token, HUB_ID, 'Mapping').catch(() => []));
    const onlySet = new Set(only.map((d) => d.toLowerCase()));
    const registry = parseAdsRegistry(regValues).filter((r) => !onlySet.size || onlySet.has(r.id.toLowerCase()));
    // Сверка ID медиапланов с листом Total (cc_dealers): регистр не мешает (сравнение без учёта регистра), но ID,
    // которого нет в Total, «Восстановить» не загрузит — это видно сразу в отчёте, а не после нажатия кнопки.
    let idAudit = { caseOnly: [], absent: [] };
    try {
      idAudit = auditRegistryIds(registry.map((r) => r.id), d1Query('SELECT DISTINCT Dealer_ID AS d FROM cc_dealers').map((r) => r.d));
      if (idAudit.caseOnly.length) console.log(`ℹ️ ID медиаплана и Total отличаются только регистром (работает, сравнение без учёта регистра): ` +
        idAudit.caseOnly.map((x) => `${x.hub} = ${x.total.join('/')}`).join(', '));
      if (idAudit.absent.length) console.log(`⚠️ ID медиаплана нет в листе Total — «Восстановить» их не загрузит: ` +
        idAudit.absent.map((x) => x.hub + (x.like.length ? ` (похожий в Total: ${x.like.join(', ')})` : '')).join(', '));
    } catch (e) {
      console.log('⚠️ Сверка ID с листом Total не выполнена: ' + e.message);
    }
    // медиаплан читается один раз на все месяцы
    prog.phase('ads'); prog.setTotal(registry.length);
    const sheets = await pool(registry, PARALLEL, (r) => { prog.source(`Медиаплан ${r.id} → лист «${r.sheet}» (таблица ${r.ss.slice(0, 8)}…)`);
      return readSheet(token, r.ss, r.sheet).then((v) => { prog.rows(v.length); prog.tick(r.id); return v; }, (e) => { prog.tick(r.id); prog.note('✗ ' + r.id + ': нет доступа'); return { error: e.message }; }); });
    const checked = new Date().toISOString();
    // листы месяцев медиаплана («Ноябрь 2026») — для раздела «Медиапланы»; только у прочитанных медиапланов
    const mpRows = [];
    const watch = []; // листы месяцев для контроля медиаплана (снимок → журнал изменений)
    prog.phase('months'); prog.setTotal(registry.length * months.length);
    for (const month of months) {
      const name = sheetName(month);
      const got = await pool(registry, PARALLEL, (r) => (sheets[registry.indexOf(r)].error ? null
        : (prog.source(`Медиаплан ${r.id} → лист «${name}»`), readSheet(token, r.ss, name).then((v) => { prog.rows(v.length); prog.tick(r.id); return v; }, (e) => { prog.tick(r.id); return { error: e.message }; }))));
      registry.forEach((r, k) => {
        if (sheets[k].error) return;
        const ads = parseAds(sheets[k], month);
        const row = { dealer: r.id, month, ss: r.ss, sheet: name, ads: JSON.stringify(ads.camp.map((c) => ({ p: c.p, n: c.name, cv: c.cv, sp: c.sp, dt: c.dt }))), checked };
        const v = got[k];
        if (!v || v.error) row.error = /Unable to parse range|not found/i.test(String(v && v.error)) ? `Нет листа «${name}»` : String(v && v.error).slice(0, 300);
        else {
          try { const mp = parseMonthSheet(v); row.meta = JSON.stringify(mp.meta); row.rows = JSON.stringify(mp.rows); watch.push({ r, month, name, values: v }); } catch (e) { row.error = e.message; }
        }
        mpRows.push(row);
      });
    }
    // Контроль медиаплана: снимок каждого листа месяца, сравнение с прошлым, утверждённый план «Общий бюджет» (S).
    let watched = 0; let changedSheets = 0;
    if (watch.length) {
      try {
        const ms = [...new Set(watch.map((w) => w.month))];
        const prev = {};
        for (const p of d1Query(`SELECT dealer, month, cells, totals FROM cc_mp_cells WHERE month IN (${ms.map(sqlLiteral).join(', ')})`)) prev[p.dealer + '|' + p.month] = p;
        const sql = [];
        const at = new Date().toISOString();
        for (const w of watch) {
          const rec = watchRecords({ dealer: w.r.id, month: w.month, ss: w.r.ss, sheet: w.name, values: w.values, prev: prev[w.r.id + '|' + w.month], at });
          if (rec.log && rec.log.source !== 'first') {
            const info = await driveInfo(token, w.r.ss);
            Object.assign(rec.log, { modified: info.modified, who: info.who });
            Object.assign(rec.cellsRow, { modified: info.modified, who: info.who });
            changedSheets++;
            console.log(`✏️ Медиаплан ${w.r.id} · ${w.name}: изменено ячеек ${rec.log.n}` + (info.who ? ` (правил: ${info.who})` : ''));
          }
          sql.push(watchSql(rec));
          watched++;
        }
        for (let i = 0; i < sql.length; i += 20) d1ExecFile(sql.slice(i, i + 20).join('\n') + '\n', 'mp-watch');
      } catch (e) {
        console.log('⚠️ Контроль медиаплана не записан: ' + e.message);
      }
    }
    const rows = [];
    const totals = { missing: 0, extra: 0, spendBad: 0, stale: 0, errors: 0, dealers: registry.length };
    const yesterday = new Date(Date.now() + 5 * 3600000 - 86400000).toISOString().slice(0, 10); // Алматы
    prog.phase('compare'); prog.setTotal(months.length);
    for (const month of months) {
      prog.source(`D1 → daily_statistics за ${month} (дилер × площадка × дата × кампания)`, true);
      const d1 = d1Month(month, only);
      // эталон — итоги кабинетов последней выгрузки (cc_cabinet, пишет run_platform.mjs), а не «Ads Data» (11.11.2026)
      const cab = {};
      for (const c of d1Query(`SELECT * FROM cc_cabinet WHERE month = ${sqlLiteral(month)}`)) (cab[String(c.dealer).toLowerCase()] = cab[String(c.dealer).toLowerCase()] || []).push(c);
      const end = monthRange(month).to;
      const expectEnd = end < yesterday ? end : yesterday;
      prog.tick(month);
      registry.forEach((r, k) => {
        const vals = sheets[k];
        // медиаплан не прочитан — строка-ошибка (нужна срезу до Hub), сверка с кабинетом всё равно делается
        const gs = (vals && vals.error ? buildGaps(r, month, { error: vals.error.replace(/\s+/g, ' ').slice(0, 300) }, [], mapping) : [])
          .concat(buildCabinetGaps(cab[r.id.toLowerCase()] || [], d1[r.id.toLowerCase()] || [], expectEnd));
        if (!gs.length) gs.push({ platform: '', error: null });
        for (const g of gs) {
          rows.push({ month, dealer: r.id, title: titles[r.id.toLowerCase()] || r.id, grp: groupOf(r.id), checked, ...g });
          if (g.gap > 0) totals.missing += g.gap;
          if (g.gap < 0) totals.extra -= g.gap;
          if (g.spend_ok === 0) totals.spendBad++;
          if (g.stale) totals.stale++;
          if (g.error && /не прочитан/.test(g.error)) totals.errors++;
        }
      });
    }
    prog.phase('write'); prog.source(`D1 → cc_gaps: ${rows.length} строк`, true); prog.rows(rows.length);
    const scope = `month IN (${months.map(sqlLiteral).join(', ')})` + (only.length ? ` AND LOWER(dealer) IN (${only.map((d) => sqlLiteral(d.toLowerCase())).join(', ')})` : '');
    d1ExecFile([`DELETE FROM cc_gaps WHERE ${scope};`, ...buildInserts('cc_gaps', COLS, rows.map((r) => Object.fromEntries(COLS.map((c) => [c, r[c] ?? null]))))].join('\n') + '\n', 'gaps');
    if (mpRows.length) {
      const mpScope = `month IN (${months.map(sqlLiteral).join(', ')}) AND dealer IN (${[...new Set(mpRows.map((r) => r.dealer))].map(sqlLiteral).join(', ')})`;
      d1ExecFile([`DELETE FROM cc_mp_sheets WHERE ${mpScope};`, ...buildInserts('cc_mp_sheets', MP_COLS, mpRows.map((r) => Object.fromEntries(MP_COLS.map((c) => [c, r[c] ?? null]))))].join('\n') + '\n', 'mp-sheets');
    }
    detail = { months, ...totals, rows: rows.length, onlyDealers: only.length, mpSheets: mpRows.filter((r) => !r.error).length,
      ghRun: process.env.GITHUB_RUN_ID || undefined, watched, changedSheets, idCase: idAudit.caseOnly.length, idAbsent: idAudit.absent.map((x) => ({ dealer: x.hub, like: x.like })) };
    console.log(`Недолёты за ${months.join(', ')}: дилеров ${registry.length}, недолетело ${totals.missing}, лишних ${totals.extra}, ` +
      `расход расходится ${totals.spendBad}, кабинет прочитан не по вчера ${totals.stale}, медиапланов не прочитано ${totals.errors / months.length}`);
  } catch (err) {
    status = 'failed';
    detail = { error: String(err.message || err).slice(0, 2000) };
    console.error(err);
  }
  d1ExecFile(`UPDATE etl_runs SET finished = ${sqlLiteral(new Date().toISOString())}, status = ${sqlLiteral(status)}, ` +
    `detail = ${sqlLiteral(JSON.stringify(detail))} WHERE id = ${sqlLiteral(runId)};`, 'gaps-end');
  if (status !== 'done') process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('gaps.mjs')) main();
