// Ход задания для админки в реальном времени («Сейчас выполняется» и «Мозг»): процент, этап, что именно обрабатывается
// (файл / лист / API / таблица), сколько строк, какой этап следующий, сколько длится каждый этап, последние события.
// Пишется в etl_runs.detail.progress, пока запуск идёт (не чаще раза в minGapMs — каждая запись в D1 — это вызов API).
// Итоговая запись в конце запуска затирает detail целиком — прогресс остаётся только у идущих запусков.

// Этапы выгрузки (доли в процентах): чтение таблиц → сбор из кабинетов → запись в D1 → сверка с BigQuery.
// Формат: [начало %, конец %, название]. Другие задания передают свои этапы в makeProgress({ phases }).
export const PHASES = {
  prepare: [0, 3, 'Читаем таблицы и курсы'],
  collect: [3, 90, 'Забираем данные из кабинетов'],
  write: [90, 96, 'Записываем в базу'],
  compare: [96, 100, 'Сверяем с BigQuery']
};

const LOG_MAX = 12;

/**
 * @param {{write: (progress: object) => void, now?: () => number, minGapMs?: number, phases?: object}} o
 */
export function makeProgress({ write, now = Date.now, minGapMs = 5000, phases = PHASES }) {
  const order = Object.keys(phases);
  let total = 1;
  let done = 0;
  let phase = order[0];
  let text = '';
  let source = '';
  let rows = 0;
  let lastAt = 0;
  const started = {}; const finished = {};
  const log = [];
  const iso = () => new Date(now()).toISOString();
  const note = (s) => { log.push({ at: iso(), text: String(s).slice(0, 200) }); if (log.length > LOG_MAX) log.shift(); };
  started[phase] = iso();
  const pct = () => {
    const [a, b] = phases[phase];
    const frac = total > 1 || done ? Math.min(1, done / Math.max(1, total)) : 0;
    return Math.round((a + (b - a) * frac) * 10) / 10;
  };
  const snapshot = () => {
    const i = order.indexOf(phase);
    return {
      pct: pct(), phase, label: phases[phase][2], text, done, total, at: iso(),
      source, rows, next: order[i + 1] ? phases[order[i + 1]][2] : '',
      steps: order.map((k, j) => ({ key: k, label: phases[k][2], state: j < i ? 'done' : j === i ? 'run' : 'wait', started: started[k] || null, finished: finished[k] || null })),
      log: log.slice()
    };
  };
  const flush = (force) => {
    const t = now();
    if (!force && t - lastAt < minGapMs) return;
    lastAt = t;
    try { write(snapshot()); } catch { /* прогресс не должен ронять задание */ }
  };
  return {
    setTotal(n) { total = Math.max(1, n); done = 0; flush(true); },
    tick(label) { done++; if (label) text = label; flush(false); },
    phase(name, label = '') {
      if (!phases[name]) return;
      if (name !== phase) { finished[phase] = iso(); started[name] = iso(); }
      phase = name; text = label; done = 0; total = 1; rows = 0;
      note('▶ ' + phases[name][2] + (label ? ' — ' + label : ''));
      flush(true);
    },
    /** Что сейчас читается или пишется: файл, лист, API, таблица. */
    source(s, force = false) { if (s !== source) { source = String(s).slice(0, 200); note(source); } flush(force); },
    /** +n обработанных строк текущего этапа. */
    rows(n) { rows += Number(n) || 0; flush(false); },
    note(s) { note(s); flush(false); },
    snapshot
  };
}

const D1_DATABASE_ID = '9d669190-f420-43be-aa8b-a4cece7c5164'; // база autoreport

/** Запрос в D1 через HTTP API без ожидания результата (ошибка не прерывает выгрузку). Нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID. */
export function d1HttpRun(sql, params = [], env = process.env, fetchImpl = fetch) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return Promise.resolve(false);
  return fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params })
  }).then((r) => r.ok).catch(() => false);
}

/**
 * Ход задания, у которого своя строка etl_runs: пишет detail = {progress} пока status = 'running'.
 * @param {string} runId
 * @param {object} phases этапы задания
 */
export function runProgress(runId, phases, extra = {}) {
  return makeProgress({ phases, minGapMs: 3000,
    write: (progress) => d1HttpRun("UPDATE etl_runs SET detail = ?1 WHERE id = ?2 AND status = 'running'", [JSON.stringify({ ...extra, progress }), runId]) });
}
