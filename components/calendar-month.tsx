"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { CalendarEvent, Member } from "@/lib/calendar-types";
import { dateRange, layoutWeek } from "@/lib/calendar-layout";

const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
const dayLabel = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });
type Range = ReturnType<typeof dateRange>;
type Props = {
  days: string[]; month: string; today: string; selected: string;
  events: CalendarEvent[]; members: Member[]; disabled: boolean;
  onSelect(day: string): void;
  onCreate(startDate: string, endDate: string): void;
};

export default function CalendarMonth({ days, month, today, selected, events, members, disabled, onSelect, onCreate }: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [range, setRange] = useState<Range | null>(null);
  const weeks = useMemo(() => Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => {
    const week = days.slice(i * 7, i * 7 + 7);
    return { days: week, segments: layoutWeek(week, events) };
  }), [days, events]);

  useEffect(() => () => cleanup.current?.(), []);

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, anchor: string) {
    // Touch keeps native scrolling; double tap and the existing add button remain available.
    if (disabled || event.button !== 0 || event.pointerType === "touch") return;
    cleanup.current?.();
    suppressClick.current = false;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let end = anchor;
    const findDay = (x: number, y: number) => {
      for (const cell of grid.current?.querySelectorAll<HTMLElement>("[data-calendar-day]") || []) {
        const rect = cell.getBoundingClientRect();
        if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return cell.dataset.calendarDay;
      }
    };
    const cancel = () => { controller.abort(); cleanup.current = null; setRange(null); };
    cleanup.current = cancel;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const day = findDay(next.clientX, next.clientY);
      if (day) { end = day; setRange(dateRange(anchor, day)); }
    };
    window.addEventListener("pointermove", move, options);
    window.addEventListener("pointerup", next => {
      if (next.pointerId !== event.pointerId) return;
      const day = findDay(next.clientX, next.clientY);
      if (day) end = day;
      cancel();
      if (end !== anchor) {
        suppressClick.current = true;
        if (day) { const chosen = dateRange(anchor, end); onSelect(chosen.startDate); onCreate(chosen.startDate, chosen.endDate); }
      }
    }, options);
    window.addEventListener("pointercancel", cancel, options);
    window.addEventListener("blur", cancel, options);
    window.addEventListener("keydown", next => { if (next.key === "Escape") cancel(); }, options);
  }

  return <div ref={grid} className="calendar-grid month-grid" role="grid" aria-label={`${month.slice(0, 7)}のカレンダー`}>
    <div className="calendar-weekdays" role="row">{weekdays.map((day, i) => <div role="columnheader" key={day} className={`weekday ${i === 0 ? "sunday" : i === 6 ? "saturday" : ""}`}>{day}</div>)}</div>
    {weeks.map(week => {
      const lanes = Math.max(0, ...week.segments.map(segment => segment.lane + 1));
      return <div className="calendar-week" role="row" key={week.days[0]} style={{ "--event-rows": lanes } as CSSProperties}>
        {week.days.map((day, column) => {
          const inRange = !!range && day >= range.startDate && day <= range.endDate;
          const count = events.filter(event => day >= event.startDate && day <= event.endDate).length;
          return <button type="button" role="gridcell" key={day} data-calendar-day={day} aria-selected={inRange || day === selected}
            aria-label={`${dayLabel.format(new Date(`${day}T00:00:00Z`))}${count ? `、予定${count}件` : ""}`}
            className={`day-cell ${day.slice(0, 7) === month.slice(0, 7) ? "" : "outside"} ${day === today ? "is-today" : ""} ${day === selected ? "selected" : ""} ${inRange ? "range-selected" : ""} ${column === 0 ? "sunday" : column === 6 ? "saturday" : ""}`}
            onPointerDown={event => beginDrag(event, day)}
            onClick={event => { if (!suppressClick.current || event.detail === 0) onSelect(day); suppressClick.current = false; }}
            onDoubleClick={event => { if (!disabled && event.button === 0 && !suppressClick.current) { onSelect(day); onCreate(day, day); } }}>
            <span className="day-number">{Number(day.slice(-2))}</span>
          </button>;
        })}
        <div className="week-events">
          {week.segments.map(segment => <button type="button" key={segment.event.id}
            className={`week-event ${segment.startsHere ? "event-start" : "event-continued"} ${segment.endsHere ? "event-end" : "event-continues"}`}
            style={{ gridColumn: `${segment.start + 1} / ${segment.end + 1}`, gridRow: segment.lane + 1, "--member-color": members.find(member => member.id === segment.event.memberId)?.color || "#bd6749" } as CSSProperties}
            title={`${segment.event.title}（${segment.event.startDate} ～ ${segment.event.endDate}）`}
            onClick={() => onSelect(week.days[segment.start])}>
            <span>{segment.event.title}</span>
          </button>)}
        </div>
      </div>;
    })}
  </div>;
}
