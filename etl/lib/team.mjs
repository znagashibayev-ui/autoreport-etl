// «Проекты команды» (таблица 1KVS5bLZHqWSe5qEyABEyBlOYLjbU7xS8NoDKis-l6q4, лист Total): проекты команды digital-маркетинга
// с ответственным, ссылкой на медиаплан и кабинетами. Админка подсвечивает эти медиапланы.
// Проект → дилер Registry: по ID таблицы из ссылки «Ссылка на МП», иначе по кабинету Meta (meta_act_ids в Registry).

export const TEAM_ID = '1KVS5bLZHqWSe5qEyABEyBlOYLjbU7xS8NoDKis-l6q4';
export const TEAM_SHEET = 'Total';

const ssId = (u) => (String(u || '').match(/\/spreadsheets\/d\/([\w-]{20,})/) || [])[1] || '';
const digits = (v) => String(v ?? '').replace(/^act_/i, '').replace(/\D/g, '');

/** URL из ячейки Sheets API (ссылка ячейки, ссылка в тексте или смарт-чип). */
export function cellUrl(cell) {
  if (!cell) return '';
  if (cell.hyperlink) return cell.hyperlink;
  for (const r of cell.chipRuns || []) { const u = r.chip && r.chip.richLinkProperties && r.chip.richLinkProperties.uri; if (u) return u; }
  for (const r of cell.textFormatRuns || []) { const u = r.format && r.format.link && r.format.link.uri; if (u) return u; }
  return '';
}

/**
 * @param {unknown[][]} values лист Total (с заголовком)
 * @param {string[]} links URL столбца «Ссылка на МП» по строкам (тот же индекс, что values)
 */
export function parseTeam(values, links) {
  const head = (values[0] || []).map((x) => String(x).trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  const c = { project: col('проект'), owner: col('ответственный'), mp: col('ссылка на мп'), meta: col('meta') };
  if (c.project < 0) throw new Error('В листе «Проекты команды» нет столбца «Проект»');
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i] || [];
    const project = String(v[c.project] ?? '').trim();
    if (!project) continue;
    out.push({ project, owner: String(v[c.owner] ?? '').trim(), mpName: String(v[c.mp] ?? '').trim(), ss: ssId(links[i]), meta: digits(v[c.meta]) });
  }
  return out;
}

/**
 * @param {object[]} team parseTeam
 * @param {unknown[][]} regValues Registry Hub (с заголовком: dealer_id, mp_spreadsheet_id, meta_act_ids)
 * @returns {{byDealer: Object<string, {project, owner}>, unmatched: string[]}}
 */
export function matchTeam(team, regValues) {
  const head = (regValues[0] || []).map((x) => String(x).trim().toLowerCase());
  const cId = head.indexOf('dealer_id'); const cSs = head.indexOf('mp_spreadsheet_id'); const cMeta = head.indexOf('meta_act_ids');
  const reg = regValues.slice(1).map((v) => ({ id: String((v || [])[cId] ?? '').trim(), ss: String((v || [])[cSs] ?? '').match(/[\w-]{20,}/)?.[0] || '',
    meta: String(cMeta >= 0 ? (v || [])[cMeta] ?? '' : '').split(/[,;\s]+/).map(digits).filter(Boolean) })).filter((r) => r.id);
  const byDealer = {}; const unmatched = [];
  for (const t of team) {
    const r = (t.ss && reg.find((x) => x.ss === t.ss)) || (t.meta && reg.find((x) => x.meta.includes(t.meta)));
    if (r) byDealer[r.id] = { project: t.project, owner: t.owner };
    else unmatched.push(t.project);
  }
  return { byDealer, unmatched };
}
