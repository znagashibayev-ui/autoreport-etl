// «Лимит Google Ads»: сколько запросов к Google Ads API ушло за каждый час (последние 50 часов) — из Google Cloud Monitoring.
// Все системы (GitHub, Worker'ы сайта, Apps Script) ходят в Google Ads через один OAuth-клиент 100140557533-…, поэтому
// метрика проекта этого клиента видит их все. Разбивка — по методу с версией API (v24 — выгрузка и Apps Script, v25 — Hub,
// placements, kpi-checker, v26 — placement-guard …) и коду ответа (429 — лимит). Итог → D1 gads_hourly, раздел «Лимит Google Ads».
//
// Доступ: сервисному аккаунту autoreport-github@… нужна роль «Monitoring Viewer» в проекте OAuth-клиента (GADS_GCP_PROJECT).

import fs from 'node:fs';
import { tokenProvider } from './lib/google.mjs';
import { d1ExecFile } from './lib/cloudflare.mjs';
import { sqlLiteral } from './lib/sql.mjs';

const PROJECT = process.env.GADS_GCP_PROJECT || '100140557533'; // номер проекта OAuth-клиента Google Ads
const HOURS = 50;

/** Ответ timeSeries.list → [{hour, method, code, n}] (точка выровнена по часу: её конец − 1 ч = начало часа). */
export function parseSeries(series) {
  const out = [];
  for (const s of series || []) {
    const method = String(((s.resource || {}).labels || {}).method || '?');
    const code = String(((s.metric || {}).labels || {}).response_code || '?');
    for (const p of s.points || []) {
      const end = Date.parse(p.interval.endTime);
      const n = Number(p.value.int64Value ?? p.value.doubleValue ?? 0);
      if (!n) continue;
      out.push({ hour: new Date(Math.floor((end - 1) / 3600000) * 3600000).toISOString(), method, code, n: Math.round(n) });
    }
  }
  return out;
}

export function saveSql(rows, fromIso) {
  const sql = [`DELETE FROM gads_hourly WHERE hour >= ${sqlLiteral(fromIso)};`];
  for (const r of rows) {
    sql.push(`INSERT OR REPLACE INTO gads_hourly (hour, method, code, n) VALUES (${sqlLiteral(r.hour)}, ${sqlLiteral(r.method)}, ${sqlLiteral(r.code)}, ${r.n});`);
  }
  return sql.join('\n');
}

async function main() {
  const say = (s) => { console.log(s); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n'); };
  const token = await tokenProvider(['https://www.googleapis.com/auth/monitoring.read'])();
  const end = new Date(); // точки выровнены по часу, текущий час — неполный
  const start = new Date(end.getTime() - HOURS * 3600000);
  const q = new URLSearchParams({
    filter: 'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api" AND resource.labels.service="googleads.googleapis.com"',
    'interval.startTime': start.toISOString(), 'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': '3600s', 'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM'
  });
  q.append('aggregation.groupByFields', 'resource.labels.method');
  q.append('aggregation.groupByFields', 'metric.labels.response_code');
  let rows = []; let pageToken = '';
  do {
    const url = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries?${q}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (j.error && j.error.message) || 'HTTP ' + res.status;
      throw new Error(`Cloud Monitoring (проект ${PROJECT}): ${msg}` + (res.status === 403
        ? ' — выдайте сервисному аккаунту autoreport-github@astana-motors-accounts.iam.gserviceaccount.com роль «Monitoring Viewer» в этом проекте Google Cloud.' : ''));
    }
    rows = rows.concat(parseSeries(j.timeSeries));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  d1ExecFile(saveSql(rows, start.toISOString()), 'gads-hourly');
  const total = rows.reduce((s, r) => s + r.n, 0);
  say(`# Лимит Google Ads: ${HOURS} ч, запросов ${total}, из них 429 — ${rows.filter((r) => r.code === '429').reduce((s, r) => s + r.n, 0)}`);
}

if (process.argv[1] && process.argv[1].endsWith('gads_usage.mjs')) {
  main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}
