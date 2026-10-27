export function normalizeRecurrence(value, startDate) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("繰り返しの規則が正しくありません。");
  const raw = value;
  if (raw.freq !== "weekly" || Object.keys(raw).some((key) => !["freq", "until", "count"].includes(key))) throw new Error("繰り返しの規則が正しくありません。");
  const until = raw.until === undefined || raw.until === null ? null : raw.until;
  const count = raw.count === undefined || raw.count === null ? null : raw.count;
  if (until !== null && (typeof until !== "string" || !isDate(until) || until < startDate || until > addYears(startDate, 1))) throw new Error("終了日は開始日以降、1年以内にしてください。");
  if (count !== null && (!Number.isInteger(count) || count < 2 || count > 53)) throw new Error("回数は2回から53回にしてください。");
  if (until === null && count === null) throw new Error("終了日または回数を指定してください。");
  const rule = { freq: "weekly", until, count };
  if (expandRecurrence(startDate, rule).length > 53) throw new Error("繰り返しは53回以内にしてください。");
  return rule;
}

export function expandRecurrence(startDate, rule) {
  if (!rule) return [startDate];
  const days = [];
  for (let n = 0; n < 54; n++) {
    const d = new Date(`${startDate}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n * 7);
    const day = d.toISOString().slice(0, 10);
    if (rule.until && day > rule.until) break;
    days.push(day);
    if (rule.count !== null && days.length >= rule.count) break;
  }
  return days;
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addYears(value, years) {
  const d = new Date(`${value}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
