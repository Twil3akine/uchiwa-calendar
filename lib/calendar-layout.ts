import type { CalendarEvent } from "./calendar-types";

export function dateRange(anchor: string, end: string) {
  return anchor <= end ? { startDate: anchor, endDate: end } : { startDate: end, endDate: anchor };
}

/** Clip to each visible week, then reserve a separate lane for overlapping spans. */
export function layoutWeek(days: string[], events: CalendarEvent[], maxLanes = Infinity) {
  if (!days.length) return [];
  const occupied: number[] = [];
  return events.filter(event => event.startDate <= days.at(-1)! && event.endDate >= days[0])
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || b.endDate.localeCompare(a.endDate) || a.id.localeCompare(b.id))
    .map(event => {
      const start = Math.max(0, days.findIndex(day => day >= event.startDate));
      const last = days.findLastIndex(day => day <= event.endDate);
      const mask = ((1 << (last - start + 1)) - 1) << start;
      let lane = occupied.findIndex(bits => (bits & mask) === 0);
      if (lane < 0) lane = occupied.length;
      if (lane >= maxLanes) return { event, start, end: last + 1, lane: maxLanes, startsHere: event.startDate >= days[0], endsHere: event.endDate <= days.at(-1)! };
      occupied[lane] = (occupied[lane] || 0) | mask;
      return { event, start, end: last + 1, lane, startsHere: event.startDate >= days[0], endsHere: event.endDate <= days.at(-1)! };
    });
}
