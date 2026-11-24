// Переходник Apps Script → Node: код Autoreport Hub (etl/hub/*.gs) выполняется без изменений.
// Apps Script синхронный, поэтому HTTP здесь тоже синхронный — через curl. Таблицы держатся в памяти
// и пишутся на flush(): медиапланы — в Google Sheets (как setValues), вкладки самого Hub — в D1 (hub_sheets).
// Оформление (цвета, ширина, шрифты) не переносится: методы-оформители ничего не делают.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

export const TZ = 'Asia/Almaty';
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms) => { if (ms > 0) Atomics.wait(SLEEP, 0, 0, ms); };

/* ---------------- HTTP ---------------- */

/** Синхронный HTTP через curl → { code, text, headers } (заголовки — нижним регистром). */
export function httpSync(url, { method = 'GET', headers = {}, body } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-'));
  const hFile = path.join(dir, 'h'); const bFile = path.join(dir, 'b'); const reqH = path.join(dir, 'rh');
  // заголовки (в них токены) — из файла, не в аргументах процесса; -L — переадресации, как UrlFetchApp
  fs.writeFileSync(reqH, Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n', { mode: 0o600 });
  const args = ['-sS', '-L', '-X', method, '--max-time', '600', '-D', hFile, '-o', bFile, '-w', '%{http_code}', '-H', '@' + reqH, url];
  if (body !== undefined && body !== null) args.push('--data-binary', '@-');
  try {
    const code = Number(execFileSync('curl', args, { input: body === undefined || body === null ? '' : body, maxBuffer: 64 * 1024 * 1024 }).toString().trim());
    const text = fs.existsSync(bFile) ? fs.readFileSync(bFile, 'utf8') : '';
    const headersOut = {};
    // при переадресации и «100 Continue» блоков заголовков несколько — берём последний
    const blocks = (fs.existsSync(hFile) ? fs.readFileSync(hFile, 'utf8') : '').split(/\r?\n\r?\n/).filter((b) => b.trim());
    for (const line of (blocks[blocks.length - 1] || '').split(/\r?\n/).slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headersOut[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { code, text, headers: headersOut };
  } catch (e) {
    throw new Error('Address unavailable: ' + url.replace(/[?#].*$/, '') + ' (' + String((e.stderr || e.message || '')).trim().slice(0, 200) + ')');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** UrlFetchApp.fetch: payload-объект — форма, строка — как есть (тип по умолчанию — форма, как в Apps Script). */
export function makeUrlFetchApp(http = httpSync) {
  return {
    fetch(url, opt = {}) {
      const method = String(opt.method || 'get').toUpperCase();
      const headers = { ...(opt.headers || {}) };
      let body;
      if (opt.payload !== undefined && opt.payload !== null) {
        if (typeof opt.payload === 'object') {
          body = new URLSearchParams(Object.entries(opt.payload).map(([k, v]) => [k, String(v)])).toString();
          headers['Content-Type'] = opt.contentType || 'application/x-www-form-urlencoded';
        } else {
          body = String(opt.payload);
          headers['Content-Type'] = opt.contentType || 'application/x-www-form-urlencoded';
        }
      } else if (opt.contentType) headers['Content-Type'] = opt.contentType;
      const r = http(url, { method, headers, body });
      if (r.code >= 400 && !opt.muteHttpExceptions) {
        throw new Error(`Request failed for ${url.replace(/[?#].*$/, '')} returned code ${r.code}. Truncated server response: ${r.text.slice(0, 300)}`);
      }
      return {
        getResponseCode: () => r.code,
        getContentText: () => r.text,
        getAllHeaders: () => ({ ...r.headers }),
        getHeaders: () => ({ ...r.headers })
      };
    }
  };
}

/* ---------------- даты ---------------- */

function parts(d, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)) o[p.type] = p.value;
  return o;
}
/** Utilities.formatDate: yyyy, MM, M, dd, d, HH, H, mm, ss. */
export function formatDate(d, tz, fmt) {
  const p = parts(d, tz || TZ);
  const map = { yyyy: p.year, MM: p.month, M: String(+p.month), dd: p.day, d: String(+p.day), HH: p.hour, H: String(+p.hour), mm: p.minute, ss: p.second };
  return String(fmt).replace(/yyyy|MM|M|dd|d|HH|H|mm|ss/g, (t) => map[t]);
}
/** Дата в ячейке так, как её набрал бы человек (USER_ENTERED превратит обратно в дату). */
export function dateCell(d) {
  const p = parts(d, TZ);
  const day = `${p.day}.${p.month}.${p.year}`;
  return p.hour === '00' && p.minute === '00' && p.second === '00' ? day : `${day} ${p.hour}:${p.minute}:${p.second}`;
}
/** «24.11.2026», «24.11.2026 7:04[:05]», «2026-11-24» → Date (по часам Алматы); иначе null. */
export function parseDateCell(s) {
  if (typeof s !== 'string') return null;
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  let y; let mo; let d; let hh = 0; let mi = 0; let ss = 0;
  if (m) { [d, mo, y] = [+m[1], +m[2], +m[3]]; hh = +(m[4] || 0); mi = +(m[5] || 0); ss = +(m[6] || 0); } else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
    if (!m) return null;
    [y, mo, d] = [+m[1], +m[2], +m[3]]; hh = +(m[4] || 0); mi = +(m[5] || 0); ss = +(m[6] || 0);
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d, hh, mi, ss); // процесс запущен с TZ=Asia/Almaty (история поясов — из tzdb)
}
/** Серийный номер даты Google Таблиц (дни от 30.12.1899, время таблицы) → Date, как getValues. */
export function serialToDate(n) {
  const u = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
}

/* ---------------- таблицы в памяти ---------------- */

const cell = (v) => (v === undefined || v === null ? '' : v);
export const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';
const noop = function () { return this; };
const FORMATTERS = ['setFontWeight', 'setBackground', 'setBackgrounds', 'setWrap', 'setVerticalAlignment', 'setNumberFormat', 'setFontSize',
  'setFontFamily', 'setFontColor', 'setHorizontalAlignment', 'setNote', 'setBorder', 'merge'];

class Range {
  constructor(sheet, r, c, nr, nc) {
    if (!(r >= 1 && c >= 1 && nr >= 1 && nc >= 1)) throw new Error(`The coordinates or dimensions of the range are invalid (${r},${c},${nr},${nc}).`);
    Object.assign(this, { sheet, r, c, nr, nc });
    for (const f of FORMATTERS) this[f] = noop;
  }
  getValues() {
    const g = this.sheet._grid(); const out = [];
    for (let i = 0; i < this.nr; i++) { const row = g[this.r - 1 + i] || []; const o = []; for (let j = 0; j < this.nc; j++) o.push(cell(row[this.c - 1 + j])); out.push(o); }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  getBackgrounds() { return Array.from({ length: this.nr }, () => Array(this.nc).fill('#ffffff')); }
  getNumRows() { return this.nr; }
  getNumColumns() { return this.nc; }
  getRow() { return this.r; }
  getColumn() { return this.c; }
  setValues(v) {
    if (!Array.isArray(v) || v.length !== this.nr || v.some((row) => !Array.isArray(row) || row.length !== this.nc)) {
      throw new Error(`The number of rows or columns in the data does not match the range (${this.nr}×${this.nc}).`);
    }
    const g = this.sheet._grid();
    v.forEach((row, i) => { const ri = this.r - 1 + i; g[ri] = g[ri] || []; row.forEach((x, j) => { g[ri][this.c - 1 + j] = cell(x); }); });
    this.sheet._touch();
    return this;
  }
  setValue(x) { return this.setValues(Array.from({ length: this.nr }, () => Array(this.nc).fill(x))); }
  clearContent() { return this.setValues(Array.from({ length: this.nr }, () => Array(this.nc).fill(''))); }
  clear() { return this.clearContent(); }
}

export class Sheet {
  /** @param {{load: () => any[][], name: string, id?: number, parent: any, created?: boolean}} o */
  constructor(o) {
    Object.assign(this, { name: o.name, id: o.id || 0, parent: o.parent, _load: o.load, grid: null, dirty: false, created: !!o.created });
    for (const f of ['setFrozenRows', 'setColumnWidth', 'setColumnWidths', 'autoResizeColumns', 'hideSheet', 'showSheet', 'setTabColor', 'activate']) this[f] = noop;
  }
  _grid() {
    if (!this.grid) {
      this.grid = (this._load ? this._load() : []).map((r) => r.slice());
      this.loadedRows = this.grid.length; this.loadedCols = Math.max(0, ...this.grid.map((r) => r.length));
    }
    return this.grid;
  }
  _touch() { this.dirty = true; }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getParent() { return this.parent; }
  getLastRow() { const g = this._grid(); for (let i = g.length - 1; i >= 0; i--) if ((g[i] || []).some((v) => cell(v) !== '')) return i + 1; return 0; }
  getLastColumn() { let n = 0; for (const r of this._grid()) for (let j = (r || []).length - 1; j >= n; j--) if (cell(r[j]) !== '') { n = j + 1; break; } return n; }
  getMaxRows() { return Math.max(this._grid().length, 1000); }
  getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getRange(r, c, nr = 1, nc = 1) {
    if (typeof r === 'string') throw new Error('getRange(A1) не поддерживается переходником');
    return new Range(this, r, c, nr, nc);
  }
  appendRow(row) { this._grid()[this.getLastRow()] = row.map(cell); this._touch(); return this; }
  deleteRows(start, n) { this._grid().splice(start - 1, n); this._touch(); return this; }
  deleteRow(r) { return this.deleteRows(r, 1); }
  insertRowsAfter(after, n) { const g = this._grid(); while (g.length < after) g.push([]); g.splice(after, 0, ...Array.from({ length: n }, () => [])); this._touch(); return this; }
  insertRowBefore(r) { return this.insertRowsAfter(r - 1, 1); }
  clearContents() { this._grid(); this.grid = []; this._touch(); return this; }
  clear() { return this.clearContents(); }
}

export class Spreadsheet {
  /** @param {{id: string, title?: string, names: string[]|null, load: (name) => any[][], ids?: object}} o */
  constructor(o) {
    this.id = o.id; this.title = o.title || o.id; this.sheets = new Map(); this._load = o.load;
    (o.names || []).forEach((n) => this.sheets.set(n, new Sheet({ name: n, id: (o.ids || {})[n], parent: this, load: () => this._load(n) })));
  }
  getId() { return this.id; }
  getName() { return this.title; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getSpreadsheetTimeZone() { return TZ; }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  getSheets() { return [...this.sheets.values()]; }
  insertSheet(n) {
    if (this.sheets.has(n)) throw new Error(`A sheet with the name "${n}" already exists.`);
    const sh = new Sheet({ name: n, parent: this, created: true }); sh.grid = []; sh.loadedRows = 0; sh.loadedCols = 0; sh.dirty = true; this.sheets.set(n, sh); return sh;
  }
  setActiveSheet(s) { return s; }
  dirtySheets() { return [...this.sheets.values()].filter((s) => s.dirty); }
}

/* ---------------- Google Sheets (медиапланы, таблица Hub) ---------------- */

/**
 * Запрос к Sheets API. Повтор: 429/5xx и сетевой сбой — до 4 раз с паузой (квота 60 запросов в минуту);
 * 401 — один раз с новым токеном (getToken(true)).
 */
export function sheetsApi(getToken, method, url, body, http = httpSync) {
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = http(url, { method, headers: { Authorization: 'Bearer ' + getToken(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (attempt < 4) { sleepSync(15000 * (attempt + 1)); continue; }
      throw e;
    }
    if (r.code === 401 && !renewed) { renewed = true; getToken(true); attempt--; continue; }
    if ((r.code === 429 || r.code >= 500) && attempt < 4) { sleepSync(15000 * (attempt + 1)); continue; }
    let j = {}; try { j = JSON.parse(r.text || '{}'); } catch { /* не JSON */ }
    if (r.code >= 400) {
      const msg = (j.error && j.error.message) || r.text.slice(0, 300) || 'HTTP ' + r.code;
      const err = new Error(r.code === 403 || r.code === 404
        ? `Нет доступа к таблице или таблица удалена (${msg}). Откройте её сервисному аккаунту autoreport-github@astana-motors-accounts.iam.gserviceaccount.com как редактору.`
        : msg);
      err.code = r.code; throw err;
    }
    return j;
  }
}
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
const rangeOf = (name) => encodeURIComponent("'" + name.replace(/'/g, "''") + "'");

/**
 * Значения листа как getValues(): числа числами, даты — Date. Дата узнаётся по тому, что ячейка даёт число серийным номером
 * и текст при выводе даты строкой, — не зависит от формата ячейки и языка таблицы.
 */
export function readGoogleSheet(getToken, id, name, http) {
  const base = `${SHEETS}${id}/values/${rangeOf(name)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS&dateTimeRenderOption=`;
  const serial = sheetsApi(getToken, 'GET', base + 'SERIAL_NUMBER', undefined, http).values || [];
  const text = sheetsApi(getToken, 'GET', base + 'FORMATTED_STRING', undefined, http).values || [];
  return serial.map((row, i) => row.map((v, j) => (typeof v === 'number' && typeof (text[i] || [])[j] === 'string' ? serialToDate(v) : v)));
}

/**
 * Записать лист целиком (как clearContents + setValues) ОДНИМ запросом: хвост прежних данных затирается пустыми ячейками,
 * поэтому сбой не оставит лист пустым. Строки — USER_ENTERED (как setValues), даты — «дд.мм.гггг».
 */
export function writeGoogleSheet(getToken, id, sheet, http, input = 'USER_ENTERED') {
  if (sheet.created) {
    const r = sheetsApi(getToken, 'POST', `${SHEETS}${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title: sheet.name } } }] }, http);
    const gp = (((r.replies || [])[0] || {}).addSheet || {}).properties || {};
    sheet.id = gp.sheetId || 0; sheet.gridRows = (gp.gridProperties || {}).rowCount || 1000; sheet.gridCols = (gp.gridProperties || {}).columnCount || 26;
  }
  const g = sheet._grid();
  const rows = Math.max(1, sheet.getLastRow(), sheet.loadedRows || 0);
  const width = Math.max(1, sheet.getLastColumn(), sheet.loadedCols || 0);
  const need = [];
  if (sheet.gridRows && rows > sheet.gridRows) need.push({ appendDimension: { sheetId: sheet.id, dimension: 'ROWS', length: rows - sheet.gridRows } });
  if (sheet.gridCols && width > sheet.gridCols) need.push({ appendDimension: { sheetId: sheet.id, dimension: 'COLUMNS', length: width - sheet.gridCols } });
  if (need.length) sheetsApi(getToken, 'POST', `${SHEETS}${id}:batchUpdate`, { requests: need }, http);
  const values = Array.from({ length: rows }, (_, i) => Array.from({ length: width }, (_, j) => { const v = cell((g[i] || [])[j]); return isDate(v) ? dateCell(v) : v; }));
  sheetsApi(getToken, 'PUT', `${SHEETS}${id}/values/${rangeOf(sheet.name)}?valueInputOption=${input}`, { range: "'" + sheet.name.replace(/'/g, "''") + "'", majorDimension: 'ROWS', values }, http);
  sheet.created = false; sheet.dirty = false;
  sheet.loadedRows = sheet.getLastRow(); sheet.loadedCols = sheet.getLastColumn();
  if (sheet.gridRows) sheet.gridRows = Math.max(sheet.gridRows, rows);
  if (sheet.gridCols) sheet.gridCols = Math.max(sheet.gridCols, width);
}

/** SpreadsheetApp.openById для Google-таблицы: список листов сразу, значения — при первом чтении. */
export function openGoogleSpreadsheet(getToken, id, http) {
  const j = sheetsApi(getToken, 'GET', `${SHEETS}${id}?fields=properties.title,sheets.properties(title,sheetId,gridProperties)`, undefined, http);
  const meta = Object.fromEntries((j.sheets || []).map((s) => [s.properties.title, s.properties]));
  const ss = new Spreadsheet({ id, title: j.properties && j.properties.title, names: Object.keys(meta), ids: Object.fromEntries(Object.entries(meta).map(([n, p]) => [n, p.sheetId])), load: (n) => readGoogleSheet(getToken, id, n, http) });
  for (const sh of ss.getSheets()) { const gp = meta[sh.getName()].gridProperties || {}; sh.gridRows = gp.rowCount || 0; sh.gridCols = gp.columnCount || 0; }
  return ss;
}

/* ---------------- сериализация вкладок Hub (D1) ---------------- */

/** Нарезка строки на части ≤ n символов, не разрывая суррогатные пары (эмодзи). */
export function chunks(s, n) {
  const out = [];
  let i = 0;
  do {
    let e = Math.min(s.length, i + n);
    const c = s.charCodeAt(e - 1);
    if (e < s.length && c >= 0xd800 && c <= 0xdbff) e--;
    out.push(s.slice(i, e)); i = e;
  } while (i < s.length);
  return out;
}
export const toJsonGrid = (g) => g.map((r) => (r || []).map((v) => (isDate(v) ? { $d: v.toISOString() } : cell(v))));
export const fromJsonGrid = (g) => (g || []).map((r) => (r || []).map((v) => (v && typeof v === 'object' && v.$d ? new Date(v.$d) : v)));

/* ---------------- окружение Apps Script ---------------- */

/**
 * Глобальные объекты Apps Script для vm-контекста.
 * @param {{active: Spreadsheet, openById: (id) => Spreadsheet, props: object, onMail?: Function, onFlush?: Function, http?: Function, log?: Function}} o
 */
export function makeGlobals(o) {
  const log = o.log || ((s) => console.log(s));
  const cache = new Map();
  const props = o.props;
  const store = {
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
    setProperty(k, v) { props[k] = String(v); return store; },
    deleteProperty(k) { delete props[k]; return store; },
    getProperties: () => ({ ...props }),
    setProperties(obj) { Object.assign(props, obj); return store; }
  };
  const trigger = { timeBased: () => trigger, after: () => trigger, atHour: () => trigger, everyDays: () => trigger, onMonthDay: () => trigger, nearMinute: () => trigger, inTimezone: () => trigger, create: () => ({}) };
  const lock = { tryLock: () => true, waitLock: () => {}, releaseLock: () => {}, hasLock: () => true };
  return {
    console,
    Logger: { log(fmt, ...a) { let i = 0; log(a.length ? String(fmt).replace(/%s|%d/g, () => String(a[i++])) : String(fmt)); } },
    Utilities: { sleep: sleepSync, formatDate },
    Session: { getScriptTimeZone: () => TZ, getEffectiveUser: () => ({ getEmail: () => '' }), getActiveUser: () => ({ getEmail: () => '' }) },
    PropertiesService: { getScriptProperties: () => store },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) && cache.get(k).t > Date.now() ? cache.get(k).v : null), put: (k, v, s = 600) => cache.set(k, { v: String(v), t: Date.now() + s * 1000 }), remove: (k) => cache.delete(k) }) },
    LockService: { getScriptLock: () => lock, getDocumentLock: () => lock },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => trigger, deleteTrigger: () => {} },
    MailApp: { sendEmail: (to, subject, body) => { (o.onMail || (() => {}))(subject, body); log('✉️ Письмо не отправлено (на сайте писем нет): ' + subject); } },
    UrlFetchApp: makeUrlFetchApp(o.http),
    SpreadsheetApp: {
      getActive: () => o.active, getActiveSpreadsheet: () => o.active, getActiveSheet: () => null,
      openById: (id) => o.openById(String(id)),
      openByUrl: (u) => o.openById((/\/d\/([\w-]{20,})/.exec(u) || [])[1] || u),
      flush: () => { if (o.onFlush) o.onFlush(); },
      getUi: () => { throw new Error('Меню Google Таблиц на сайте нет'); }
    }
  };
}

/** Выполнить файлы .gs в одном контексте, как один проект Apps Script (по алфавиту, как в редакторе). */
export function loadGas(dir, globals) {
  // Date и Array — общие с переходником, иначе instanceof Date в коде Hub не узнает даты из таблиц
  const ctx = vm.createContext({ ...globals, Date, Array, Object, JSON, Math });
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}
