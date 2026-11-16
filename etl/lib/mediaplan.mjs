// Лист месяца медиаплана («Ноябрь 2026»): разбор и правки бюджета.
// Устройство листа (MP | Changan Al-farabi, 09.11.2026): блок «Период» (A3 начало, A4 конец, A5 дней, B3 бюджет с НДС и АК в ₸, C3 курс),
// таблица с заголовком «Площадка | Инструмент | Кампания | План/Факт | … | Дневной бюджет | Общий бюджет | … | % от бюджета | …»:
// по каждой площадке строка-итог (План / Факт / Выполнение), затем пары строк кампании «План» + «Факт».
// Бюджет кампании задаётся только долей: U площадки (доля всего бюджета) и U кампании (доля бюджета площадки);
// W = бюджет × доли (₸ с НДС и АК), V = W / курс, S = V / НДС / комиссия ($ без налогов), R = S / дней (дневной бюджет).
// Поэтому правка бюджета = запись долей U; формулы таблицы пересчитывают всё сами.

export const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const PL = { google: 'Google Ads', meta: 'Meta', tiktok: 'TikTok', yandex: 'Yandex' };
// Медиапланы ведут и на английском (BMW Kazakhstan, 12.11.2026: «Period», «Campaign», «Plan / Fact») — подписи сравниваются без регистра.
const HEAD = { 'площадка': 'platform', 'инструмент': 'tool', 'кампания': 'name', 'цель': 'goal', 'показы': 'imps', 'частота': 'freq', 'охват': 'reach',
  'клики': 'clicks', 'ctr': 'ctr', 'cpc': 'cpc', 'cpl': 'cpl', 'процент конверсий': 'cr', 'конверсии': 'conv', 'дневной бюджет': 'daily',
  'общий бюджет': 'total', 'общий бюджет, тг': 'kzt', '% от бюджета': 'share', 'бюджет с ндс и ви, тг': 'gross',
  'advertising platform': 'platform', 'platform': 'platform', 'tool': 'tool', 'campaign': 'name', 'target': 'goal', 'goal': 'goal',
  'impression': 'imps', 'impressions': 'imps', 'frequency': 'freq', 'reach': 'reach', 'clicks': 'clicks', 'conversion rate': 'cr', 'conversions': 'conv',
  'daily budget $': 'daily', 'daily budget, $': 'daily', 'daily budget': 'daily',
  'total budget without vat and commission, $': 'total', 'total budget without vat and commission': 'total',
  'total budget, without vat and commission, tenge': 'kzt', 'total budget without vat and commission, tenge': 'kzt',
  '% of the budget': 'share', '% of budget': 'share', 'budget with vat and commission, tenge': 'gross' };
/** Подпись ячейки для сравнения: регистр и переносы строк не важны («Plan/⏎Fact» = «plan/ fact»). */
export const lab = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const PLAN = new Set(['план', 'plan']); const FACT = new Set(['факт', 'fact']); const EXEC = new Set(['выполнение', 'execution']);
const TOTAL = new Set(['total', 'итого']);
/** Слово столбца «План/Факт»: 'plan' | 'fact' | 'exec' | ''. */
export function pfKind(v) { const x = lab(v); return PLAN.has(x) ? 'plan' : FACT.has(x) ? 'fact' : EXEC.has(x) ? 'exec' : ''; }
// Бюджет в тенге для людей — столбец T «Общий бюджет, тг» (S × курс, без НДС и АК). W «Бюджет с НДС и ВИ, тг» (gross) нужен только
// внутри расчёта долей: формулы листа считают W = бюджет медиаплана × доли, а дневной бюджет — от W (netPerGross).

export function sheetName(month) {
  return MONTHS_RU[Number(month.slice(5, 7)) - 1] + ' ' + month.slice(0, 4);
}

/** 'Tiktok' / 'Google' из листа → название площадки в D1. */
export function d1Platform(s) {
  return PL[String(s || '').trim().toLowerCase()] || '';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')) || 0);
const str = (v) => String(v ?? '').trim();
const serialIso = (v) => (typeof v === 'number' && v > 30000 ? new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10) : '');
export function colLetter(i) { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; }

/** Кампания охватная (деньги в первую очередь забираются отсюда). */
export function isAwareness(c) {
  return /_awar|awareness|_reach|_video/i.test(c.name || '') || /охват|узнаваем|просмотр/i.test((c.goal || '') + ' ' + (c.tool || ''));
}

/**
 * @param {unknown[][]} v значения листа с A1 (UNFORMATTED_VALUE)
 * @returns {{meta: object, rows: object[]}} rows — кампании с номерами строк листа (1-based)
 */
export function parseMonthSheet(v) {
  v = v || [];
  const at = (r, c) => (v[r] || [])[c];
  const pr = v.findIndex((row) => ['период', 'period'].includes(lab((row || [])[0])));
  if (pr < 0) throw new Error('В листе нет блока «Период»');
  const meta = { start: serialIso(at(pr + 1, 0)), end: serialIso(at(pr + 2, 0)), days: num(at(pr + 3, 0)), budget: num(at(pr + 1, 1)),
    rate: num(at(pr + 1, 2)), fees: {}, platforms: [], cols: {}, total: {} };
  const hr = v.findIndex((row, i) => i > pr && HEAD[lab((row || [])[0])] === 'platform' && HEAD[lab((row || [])[2])] === 'name');
  if (hr < 0) throw new Error('В листе нет таблицы «Площадка | Инструмент | Кампания»');
  const C = {};
  (v[hr] || []).forEach((h, i) => { const k = HEAD[lab(h)]; if (k && C[k] === undefined) C[k] = i; });
  C.pf = 3;
  // последний столбец таблицы плана (дальше пусто, затем блок факта AH:AN — его формула-массив не копируется)
  let last = 0;
  while (str((v[hr] || [])[last + 1])) last++;
  meta.lastCol = last;
  meta.headerRow = hr + 1;
  for (const k of ['name', 'daily', 'total', 'share', 'gross', 'conv']) if (C[k] === undefined) throw new Error('В таблице нет столбца ' + k);
  meta.cols = Object.fromEntries(Object.entries(C).map(([k, i]) => [k, colLetter(i)]));
  const rows = [];
  let cur = null;
  for (let r = hr + 1; r < v.length; r++) {
    const a = str(at(r, 0)); const pf = pfKind(at(r, C.pf));
    if (TOTAL.has(lab(a))) {
      // строка «Total»: План / Факт «Общего бюджета» (S) и бюджета с НДС и АК всего медиаплана
      for (let t = r; t < Math.min(v.length, r + 4); t++) {
        const k0 = pfKind(at(t, C.pf)) || pfKind(at(t, C.pf + 1));
        const k = k0 === 'plan' || k0 === 'fact' ? k0 : '';
        if (k) meta.total[k] = { total: num(at(t, C.total)), daily: num(at(t, C.daily)), gross: num(at(t, C.gross)), kzt: C.kzt === undefined ? null : num(at(t, C.kzt)), conv: num(at(t, C.conv)), row: t + 1 };
      }
      break;
    }
    if (pf !== 'plan') continue;
    if (pfKind(at(r + 2, C.pf)) === 'exec') { // строка-итог площадки
      cur = { platform: a, row: r + 1, share: num(at(r, C.share)), gross: num(at(r, C.gross)), total: num(at(r, C.total)), conv: num(at(r, C.conv)), first: 0,
        kzt: C.kzt === undefined ? null : num(at(r, C.kzt)), daily: num(at(r, C.daily)),
        fact: { total: num(at(r + 1, C.total)), daily: num(at(r + 1, C.daily)), gross: num(at(r + 1, C.gross)), kzt: C.kzt === undefined ? null : num(at(r + 1, C.kzt)), conv: num(at(r + 1, C.conv)) } }; // строка «Факт» итога площадки
      meta.platforms.push(cur);
      continue;
    }
    const f = pfKind(at(r + 1, C.pf)) === 'fact' ? r + 1 : -1;
    const p = a || (cur && cur.platform) || '';
    if (cur && !cur.platform) cur.platform = p;
    const g = (k, rr = r) => (C[k] === undefined ? 0 : num(at(rr, C[k])));
    rows.push({
      row: r + 1, platform: p, d1: d1Platform(p), tool: str(at(r, C.tool)), name: str(at(r, C.name)), goal: str(at(r, C.goal)),
      share: g('share'), daily: g('daily'), total: g('total'), gross: g('gross'), conv: g('conv'), cpc: g('cpc'), cr: g('cr'), ctr: g('ctr'), freq: g('freq'),
      fact: f < 0 ? null : { conv: g('conv', f), spend: g('total', f), clicks: g('clicks', f), imps: g('imps', f) }
    });
  }
  // таблица комиссий: «Название площадки | Показатель | Комиссия | НДС» — строки «План». Ищем по столбцам «Комиссия | НДС»:
  // подпись первого столбца у английского листа может быть любой.
  const fr = v.findIndex((row) => ['комиссия', 'commission'].includes(lab((row || [])[2])) && ['ндс', 'vat'].includes(lab((row || [])[3])));
  if (fr >= 0) {
    let p = '';
    for (let r = fr + 1; r < v.length && r < fr + 30; r++) {
      if (TOTAL.has(lab(at(r, 0)))) break;
      if (str(at(r, 0))) p = str(at(r, 0));
      if (pfKind(at(r, 1)) === 'plan' && p) meta.fees[d1Platform(p) || p] = { comm: num(at(r, 2)) || 1, nds: num(at(r, 3)) || 1 };
    }
  }
  return { meta, rows };
}

/**
 * Доли, которые в сумме дают ровно 1: округление до 1e-9, остаток — самой большой доле. Иначе (11.11.2026) сумма долей выходила 0,999999,
 * и план S площадки после правки «уезжал» на −0,02 при неизменном бюджете.
 */
export function exactShares(weights) {
  const sum = weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const out = weights.map((w) => Math.round(((w > 0 ? w : 0) / sum) * 1e9) / 1e9);
  let big = 0;
  out.forEach((v, i) => { if (v > out[big]) big = i; });
  out[big] = Math.round((1 - out.reduce((a, v, i) => a + (i === big ? 0 : v), 0)) * 1e9) / 1e9;
  return out;
}

/** Дневной бюджет ($ без налогов) за 1 ₸ брутто для площадки: 1 / курс / НДС / комиссия. */
/** Ключ имени кампании: регистр, пробелы, «-» и «_» не различаются (meta_awar_x-y и meta_awar_x_y — одна кампания). */
export function nameKey(n) { return String(n || '').trim().toLowerCase().replace(/[\s_\-]+/g, '_'); }

/** Расстояние Левенштейна (для «похожих» имён кампаний). */
export function editDistance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}

/** Похожие имена: отличаются 1–3 символами (опечатка) — то же правило, что в планировщике (public/mp-calc.js similarNames). */
export function similarNames(name, names) {
  const k = nameKey(name);
  return names.filter((n) => { const x = nameKey(n); return x !== k && k.length >= 8 && editDistance(x, k) <= 3; });
}

/**
 * Дневной бюджет на 1 ₸ брутто для строки листа. У строки бывает своя формула «Дневного бюджета» (Hyundai Qalqaman, 12.11.2026:
 * meta_awar_…_service_location делит «Общий бюджет» на 24 дня, а не на 30) — берём отношение из самой строки; у пустой
 * (новой) строки — из ближайшей строки площадки ниже (новая пара копируется с неё), иначе из последней строки площадки.
 */
export function rowK(rows, r, d1, k) {
  const ratio = (x) => (x && x.daily > 0 && x.gross > 0 ? x.daily / x.gross : 0);
  if (ratio(r)) return ratio(r);
  const own = rows.filter((x) => x.d1 === d1 && ratio(x)).sort((a, b) => a.row - b.row);
  const below = r && r.row ? own.find((x) => x.row > r.row) : null;
  return ratio(below || own[own.length - 1]) || k;
}

export function netPerGross(meta, d1) {
  const f = meta.fees[d1] || { comm: 1, nds: 1 };
  return meta.rate > 0 && meta.days > 0 ? 1 / meta.rate / f.nds / f.comm / meta.days : 0;
}

/**
 * Новые дневные бюджеты → записи в лист (доли U). Кампании без строки (новые) занимают пустые строки «План» своей площадки.
 * @param {{meta, rows}} mp разобранный лист
 * @param {{name, d1, daily, tool?, goal?, cpl?}[]} plan все кампании с бюджетами (существующие по name, новые — new: true)
 * @param {'platform'|'all'} scope platform — бюджет каждой площадки не меняется; all — меняются и доли площадок
 * @param {{insert?: boolean}} opts insert — нет свободной строки: не ошибка, а «вставить пару строк» (inserts[площадка]++)
 * @returns {{ops: {row, col, value, expect}[], summary: string[], inserts: Object<string, number>}}
 */
export function planToOps(mp, plan, scope, opts = {}) {
  const { meta, rows } = mp;
  const C = meta.cols;
  const ops = []; const summary = [];
  const byPlatform = {};
  const used = new Set();
  const inserts = {};
  // Защита от дублей (11.11.2026: tiktok_perf_changan_hunter-plus добавилась дважды — админка отправила «новую» кампанию,
  // которая уже была записана прошлой правкой): кампания с таким именем в листе — это она, новая пара строк не вставляется;
  // одно имя дважды в одной правке — берётся первое.
  const seen = new Set();
  plan = plan.filter((c) => { const k = nameKey(c.name); if (seen.has(k)) return false; seen.add(k); return true; });
  for (const c of plan) {
    // одна кампания = один ключ имени: «_» и «-», регистр и пробелы не различаются (иначе в листе появляется почти-дубль)
    let row = rows.find((r) => r.name && nameKey(r.name) === nameKey(c.name)) || null;
    if (!row && c.new) {
      const like = similarNames(c.name, rows.filter((r) => r.name).map((r) => r.name));
      if (like.length) summary.push(`⚠️ ${c.d1}: ${c.name} похожа на ${like.join(', ')} — проверьте, что это другая кампания`);
    }
    if (row && c.new) summary.push(`${c.d1}: ${c.name} уже есть в листе (строка ${row.row}) — новая строка не добавлена, меняется её бюджет`);
    // «та же кампания» с другим именем в кабинете: строке листа ставится имя из кабинета, иначе факт по ней не находится
    if (row && row.row && c.rename && nameKey(c.rename) !== nameKey(row.name)) {
      const other = rows.find((r) => r.name && r !== row && nameKey(r.name) === nameKey(c.rename));
      if (other) throw new Error(`${c.d1}: «${c.rename}» уже есть в листе (строка ${other.row}) — переименовать «${row.name}» нельзя`);
      ops.push({ row: row.row, col: C.name, value: c.rename, expect: row.name });
      summary.push(`✎ ${c.d1}: «${row.name}» → «${c.rename}» (строка ${row.row}, имя как в кабинете)`);
    }
    if (!row) {
      row = rows.find((r) => !r.name && r.d1 === c.d1 && !used.has(r.row));
      if (!row && opts.insert) {
        if (!rows.some((r) => r.d1 === c.d1)) throw new Error(`В листе нет блока площадки ${c.d1} — новую строку не по чему скопировать`);
        inserts[c.d1] = (inserts[c.d1] || 0) + 1;
        summary.push(`+ ${c.d1}: ${c.name} — ${c.daily.toFixed(2)}/день (новая пара строк «План/Факт»)`);
        row = { row: null, name: '', d1: c.d1, share: 0, daily: 0 };
      } else {
      if (!row) throw new Error(`В листе нет свободной строки «План» для площадки ${c.d1} — добавьте пару строк «План/Факт» в таблицу вручную`);
      ops.push({ row: row.row, col: C.name, value: c.name, expect: '' });
      if (C.tool && c.tool) ops.push({ row: row.row, col: C.tool, value: c.tool, expect: '' });
      if (C.goal && c.goal) ops.push({ row: row.row, col: C.goal, value: c.goal, expect: '' });
      // плановый CPL новой кампании = CPC / CR: CR берём как у соседей площадки, CPC подбираем под ожидаемый CPL
      const ref = rows.find((r) => r.d1 === c.d1 && r.name && r.cr > 0);
      const cr = ref ? ref.cr : 0.05;
      if (C.cr) ops.push({ row: row.row, col: C.cr, value: cr, expect: '' });
      if (C.cpc && c.cpl > 0) ops.push({ row: row.row, col: C.cpc, value: Math.round(c.cpl * cr * 100) / 100, expect: '' });
      if (C.ctr && ref && ref.ctr) ops.push({ row: row.row, col: C.ctr, value: ref.ctr, expect: '' });
      if (C.freq && ref && ref.freq) ops.push({ row: row.row, col: C.freq, value: ref.freq, expect: '' });
      summary.push(`+ ${c.d1}: ${c.name} — ${c.daily.toFixed(2)}/день (строка ${row.row})`);
      }
    }
    if (row.row) used.add(row.row);
    const k = netPerGross(meta, c.d1);
    if (!k) throw new Error('В листе нет курса или числа дней — бюджет не пересчитать');
    const gross = c.daily / rowK(rows, row, c.d1, k);
    (byPlatform[c.d1] = byPlatform[c.d1] || []).push({ row, gross, c });
  }
  for (const [d1, list] of Object.entries(byPlatform)) {
    const sum = list.reduce((s, x) => s + x.gross, 0);
    // площадка может стоять в листе несколькими блоками-итогами с одним названием — бюджет площадки = их сумма
    const pblocks = meta.platforms.filter((p) => d1Platform(p.platform) === d1);
    const pg = pblocks.reduce((s2, p) => s2 + (p.gross || 0), 0);
    // allowOver (Genesis, 12.11.2026): записать кампании со своими бюджетами, даже если сумма больше бюджета площадки —
    // доли = бюджет кампании / бюджет площадки (в сумме больше 100%), перерасчёт делают вручную потом
    const over = !!opts.allowOver && scope !== 'all' && pg > 0;
    if (scope !== 'all' && !over) {
      if (pblocks.length && pg > 0 && Math.abs(sum - pg) / pg > 0.005) {
        throw new Error(`${d1}: сумма бюджетов ${Math.round(sum)} ₸ не равна бюджету площадки ${Math.round(pg)} ₸ — сбалансируйте перед записью`);
      }
    }
    if (over && Math.abs(sum - pg) / pg > 0.005) {
      summary.push(`⚠️ ${d1}: записано ${sum > pg ? 'с перерасходом' : 'с недораспределением'} — доли кампаний в сумме ${(sum / pg * 100).toFixed(1)}% бюджета площадки. Перераспределите позже`);
    }
    // без перерасчёта неизменённые кампании сохраняют свою долю как есть (иначе округление переписало бы все строки)
    const shares = over ? list.map((x) => (x.row.row && x.row.name && Math.abs(x.c.daily - x.row.daily) < 0.005 ? x.row.share : Math.round(x.gross / pg * 1e9) / 1e9)) : exactShares(list.map((x) => x.gross));
    // доли до правки не 100% → правка раздаст весь бюджет площадки и план S сдвинется: сказать об этом прямо (Changan Zhansugurova, +$25,71)
    const was = rows.filter((r) => r.d1 === d1 && r.name).reduce((s2, r) => s2 + (r.share || 0), 0);
    if (was > 0 && Math.abs(was - 1) > 0.001) {
      const sNow = rows.filter((r) => r.d1 === d1).reduce((s2, r) => s2 + (r.total || 0), 0);
      const dS = sNow / was - sNow;
      summary.push(`⚠️ ${d1}: до правки доли кампаний давали ${(was * 100).toFixed(1)}% бюджета площадки, после — 100%: план «Общий бюджет» (S) площадки ${dS >= 0 ? '+' : '−'}$${Math.abs(dS).toFixed(2)}. Новый план утвердите кнопкой «Утвердить текущий план»`);
    }
    for (const [i, x] of list.entries()) {
      const share = shares[i];
      if (x.row.row && (Math.abs(share - x.row.share) > 1e-9 || !x.row.name)) {
        ops.push({ row: x.row.row, col: C.share, value: share, expect: x.row.name });
        if (x.row.name && Math.abs(x.c.daily - x.row.daily) >= 0.01) summary.push(`${d1}: ${x.row.name} — $${x.row.daily.toFixed(2)} → $${x.c.daily.toFixed(2)}/день`);
      }
    }
    // кампании площадки, которых нет в плане (выключены) — доля 0
    for (const r of rows) {
      if (r.d1 === d1 && r.name && r.share > 0 && !list.some((x) => x.row.row === r.row)) {
        ops.push({ row: r.row, col: C.share, value: 0, expect: r.name });
        summary.push(`${d1}: ${r.name} — бюджет 0`);
      }
    }
    if (scope === 'all') {
      const blocks = meta.platforms.filter((p) => d1Platform(p.platform) === d1);
      if (!blocks.length) throw new Error('Нет строки-итога площадки ' + d1);
      // доля медиаплана пишется в одну строку-итог; при двух блоках с одним названием неясно, в какую — сначала исправить лист
      if (blocks.length > 1) throw new Error(`${d1}: в листе ${blocks.length} блока-итога с этим названием (строки ${blocks.map((p) => p.row).join(', ')}) — переименуйте лишний в столбце A`);
      const prow = blocks[0];
      const share = meta.budget > 0 ? sum / meta.budget : 0;
      if (Math.abs(share - prow.share) > 1e-6) {
        ops.push({ row: prow.row, col: C.share, value: Math.round(share * 1e9) / 1e9, expect: '' });
        summary.push(`${d1}: доля медиаплана ${(prow.share * 100).toFixed(1)}% → ${(share * 100).toFixed(1)}%`);
      }
    }
  }
  if (scope === 'all') {
    const tot = Object.values(byPlatform).flat().reduce((s, x) => s + x.gross, 0);
    const others = meta.platforms.filter((p) => !byPlatform[d1Platform(p.platform)]).reduce((s, p) => s + p.gross, 0);
    if (meta.budget > 0 && Math.abs(tot + others - meta.budget) / meta.budget > 0.005) {
      throw new Error(`Сумма бюджетов ${Math.round(tot + others)} ₸ не равна бюджету медиаплана ${Math.round(meta.budget)} ₸ — сбалансируйте перед записью`);
    }
  }
  return { ops, summary, inserts };
}

/**
 * Вставка пар строк «План/Факт» для новых кампаний: перед последней парой площадки (внутри диапазонов СУММЕСЛИ итога площадки),
 * копия этой пары (формулы, объединения, проверки данных) только в столбцах таблицы плана, затем очистка имени/инструмента/цели/ссылки/доли.
 * Площадки обрабатываются снизу вверх, поэтому номера строк исходного листа остаются верными.
 * @returns {{requests: object[], clear: string[]}} clear — ячейки A1 (без имени листа) в строках «План» новых пар после всех вставок
 */
export function insertRequests(mp, inserts, sheetId) {
  const { meta, rows } = mp;
  const blocks = Object.entries(inserts).filter(([, n]) => n > 0).map(([d1, n]) => {
    const own = rows.filter((r) => r.d1 === d1);
    if (!own.length) throw new Error('В листе нет блока площадки ' + d1);
    return { d1, n, at: Math.max(...own.map((r) => r.row)) }; // строка «План» последней пары (1-based)
  }).sort((a, b) => b.at - a.at);
  const cols = meta.lastCol + 1;
  const requests = []; const clear = [];
  for (const b of blocks) {
    const s0 = b.at - 1; const k = 2 * b.n;
    requests.push({ insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: s0, endIndex: s0 + k }, inheritFromBefore: true } });
    requests.push({ copyPaste: { source: { sheetId, startRowIndex: s0 + k, endRowIndex: s0 + k + 2, startColumnIndex: 0, endColumnIndex: cols },
      destination: { sheetId, startRowIndex: s0, endRowIndex: s0 + k, startColumnIndex: 0, endColumnIndex: cols }, pasteType: 'PASTE_NORMAL' } });
  }
  for (const b of blocks) {
    const shift = blocks.filter((o) => o.at < b.at).reduce((s, o) => s + 2 * o.n, 0);
    for (let i = 0; i < b.n; i++) {
      const r = b.at + shift + 2 * i;
      for (const key of ['name', 'tool', 'goal', 'share']) if (meta.cols[key]) clear.push(meta.cols[key] + r);
      if (cols > 6) clear.push('G' + r); // «Ссылка»
    }
  }
  return { requests, clear };
}

/* ---------- удаление кампании и откат ---------- */

/**
 * Удаление кампании из листа месяца: пара строк «План/Факт» удаляется целиком; если у площадки это последняя кампания —
 * строки остаются (по ним копируются новые пары), очищаются имя/инструмент/цель/доля. Бюджет площадки не меняется:
 * доля удалённой кампании после удаления раздаётся остальным кампаниям площадки пропорционально (rebalanceOps).
 * @param {{meta, rows}} mp разобранный лист
 * @param {{row: number, name: string}} target строка «План» и имя (проверка, что лист не сдвинулся)
 * @returns {{mode: 'delete'|'clear', d1: string, start?: number, end?: number, clear?: string[], name: string, share: number}}
 */
export function deletePlan(mp, target) {
  const name = String(target.name || '').trim().toLowerCase();
  let r = mp.rows.find((x) => x.row === Number(target.row) && x.name.toLowerCase() === name);
  if (!r) {
    const same = mp.rows.filter((x) => x.name.toLowerCase() === name);
    if (same.length !== 1) throw new Error(same.length ? `«${target.name}» в листе несколько раз, а в строке ${target.row} её уже нет — перечитайте медиаплан и удалите нужную строку заново`
      : `Кампании «${target.name}» в листе уже нет`);
    r = same[0];
  }
  const siblings = mp.rows.filter((x) => x.platform === r.platform && x.row !== r.row);
  if (!siblings.length) {
    const C = mp.meta.cols;
    return { mode: 'clear', d1: r.d1, name: r.name, share: r.share, row: r.row,
      clear: ['name', 'tool', 'goal', 'share'].filter((k) => C[k]).map((k) => C[k] + r.row) };
  }
  // 0-based [start, end): «План» и, если есть, «Факт» под ним
  return { mode: 'delete', d1: r.d1, name: r.name, share: r.share, row: r.row, start: r.row - 1, end: r.fact ? r.row + 1 : r.row };
}

/** Доли кампаний площадки → в сумме 100% (пропорционально нынешним). Пусто, если менять нечего. */
export function rebalanceOps(mp, d1) {
  const own = mp.rows.filter((r) => r.d1 === d1 && r.name);
  const sum = own.reduce((s, r) => s + (r.share || 0), 0);
  if (!own.length || !(sum > 0) || Math.abs(sum - 1) < 1e-12) return [];
  const shares = exactShares(own.map((r) => r.share || 0));
  return own.map((r, i) => ({ row: r.row, col: mp.meta.cols.share, value: shares[i], expect: r.name })).filter((o, i) => Math.abs(o.value - (own[i].share || 0)) > 1e-12);
}

const a1Parts = (a1) => { const m = String(a1).match(/^([A-Z]+)(\d+)$/); return m ? { c: m[1].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1, r: Number(m[2]) - 1 } : null; };
const same = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Math.abs(Number(a) - Number(b)) < 1e-6 : String(a ?? '').trim() === String(b ?? '').trim());

/**
 * «Вернуть как было» для записи журнала: какие ячейки записать старыми значениями.
 * Формулы не трогаются (пересчитаются сами), факт не трогается; ячейка, которую после этой записи поменяли ещё раз
 * или чья строка сдвинулась (другая подпись), пропускается — чтобы не затереть более позднюю правку.
 * @param {{a1, row, col, old, new, kind}[]} changes изменения записи журнала
 * @param {unknown[][]} values текущие значения листа; @param {unknown[][]} formulas тот же лист в виде формул
 * @param {{rows: Object<number,string>}} labels подписи строк текущего листа
 */
export function rollbackOps(changes, values, formulas, labels) {
  const writes = []; const skipped = { formula: 0, fact: 0, later: 0, moved: 0 };
  for (const ch of changes || []) {
    if (ch.kind === 'fact') { skipped.fact++; continue; }
    const p = a1Parts(ch.a1);
    if (!p) continue;
    const f = (formulas[p.r] || [])[p.c];
    if (typeof f === 'string' && f.startsWith('=')) { skipped.formula++; continue; }
    if (labels.rows[p.r + 1] !== ch.row) { skipped.moved++; continue; }
    if (!same((values[p.r] || [])[p.c] ?? '', ch.new)) { skipped.later++; continue; }
    writes.push({ a1: ch.a1, value: ch.old === null || ch.old === undefined ? '' : ch.old, from: ch.new });
  }
  return { writes, skipped };
}

/**
 * Несколько записей журнала (по порядку, старые первыми) → одна правка на ячейку: «было» — до первой записи, «стало» — после последней.
 * Так «вернуть к состоянию на момент» = откат одной сводной правки (rollbackOps).
 */
export function mergeChanges(entries) {
  const by = new Map();
  for (const e of entries) {
    for (const ch of e.changes || []) {
      const x = by.get(ch.a1);
      if (!x) by.set(ch.a1, { ...ch });
      else Object.assign(x, { new: ch.new, row: ch.row, col: ch.col, kind: x.kind === 'plan' || ch.kind === 'plan' ? 'plan' : ch.kind });
    }
  }
  return [...by.values()].filter((c) => !same(c.old ?? '', c.new ?? '')); // туда и обратно — нечего возвращать
}

/**
 * Автовыравнивание площадки: доли кампаний должны давать ровно 100%, иначе «Общий бюджет» S площадки уходит от утверждённого.
 * Кампании, чью долю правили руками (locked), остаются как есть; разница раздаётся остальным пропорционально их долям.
 * Если править некому (все тронуты или все 0) — ops пустой, reason объясняет.
 * @returns {{ops: object[], moves: {name, row, fromShare, toShare, fromDaily, toDaily, fromS, toS}[], reason?: string, sum: number}}
 */
export function autoFixOps(mp, d1, locked = []) {
  const own = mp.rows.filter((r) => r.d1 === d1 && r.name);
  const sum = own.reduce((s, r) => s + (r.share || 0), 0);
  if (!own.length) return { ops: [], moves: [], sum, reason: 'у площадки нет кампаний' };
  if (Math.abs(sum - 1) < 1e-9) return { ops: [], moves: [], sum, reason: 'доли кампаний площадки уже 100%: план S сейчас ровно равен бюджету площадки из листа. Утверждённый план отличается, потому что его утвердили, когда часть бюджета площадки не была распределена (доли не 100%), или в листе изменили бюджет площадки, курс или дни. Если текущий план верный — «Утвердить текущий план»' };
  const keep = new Set(locked.map((n) => String(n).toLowerCase()));
  const fixed = own.filter((r) => keep.has(r.name.toLowerCase()));
  const free = own.filter((r) => !keep.has(r.name.toLowerCase()) && r.share > 0);
  const room = 1 - fixed.reduce((s, r) => s + (r.share || 0), 0);
  if (!free.length) return { ops: [], moves: [], sum, reason: 'все кампании площадки правили руками — раздать разницу некому' };
  if (room <= 0) return { ops: [], moves: [], sum, reason: 'кампании, которые правили руками, уже забрали весь бюджет площадки' };
  const shares = exactShares(free.map((r) => r.share)).map((s) => Math.round(s * room * 1e9) / 1e9);
  // остаток округления — самой большой из свободных, чтобы сумма с тронутыми была ровно 1
  const total = fixed.reduce((s, r) => s + r.share, 0) + shares.reduce((s, v) => s + v, 0);
  let big = 0; shares.forEach((v, i) => { if (v > shares[big]) big = i; });
  shares[big] = Math.round((shares[big] + 1 - total) * 1e9) / 1e9;
  const ops = []; const moves = [];
  free.forEach((r, i) => {
    if (Math.abs(shares[i] - r.share) < 1e-12) return;
    const k = r.share > 0 ? shares[i] / r.share : 0;
    ops.push({ row: r.row, col: mp.meta.cols.share, value: shares[i], expect: r.name });
    moves.push({ name: r.name, row: r.row, fromShare: r.share, toShare: shares[i], fromDaily: r.daily, toDaily: Math.round(r.daily * k * 100) / 100,
      fromS: r.total, toS: Math.round(r.total * k * 100) / 100 });
  });
  return { ops, moves, sum };
}
