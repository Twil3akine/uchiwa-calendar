"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from "react";
import type { CalendarEvent, Member } from "@/lib/calendar-types";
import { dateRange, layoutWeek } from "@/lib/calendar-layout";
import { startTouchGesture } from "@/lib/calendar-gesture.mjs";

const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
const dayLabel = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });
type Range = ReturnType<typeof dateRange>;
type Props = {
  days: string[]; month: string; today: string; selected: string;
  events: CalendarEvent[]; members: Member[]; disabled: boolean;
  onSelect(day: string): void;
  onCreate(startDate: string, endDate: string): void;
  onNavigateMonth(direction: -1 | 1): void;
};

export default function CalendarMonth({ days, month, today, selected, events, members, disabled, onSelect, onCreate, onNavigateMonth }: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | null>(null);
  const actions = useRef({ onSelect, onCreate, onNavigateMonth });
  const [range, setRange] = useState<Range | null>(null);
  const weeks = useMemo(() => Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => {
    const week = days.slice(i * 7, i * 7 + 7);
    return { days: week, segments: layoutWeek(week, events, 3) };
  }), [days, events]);

  useEffect(() => () => cleanup.current?.(), [month, disabled]);
  useEffect(() => () => { if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current); }, []);
  useEffect(() => { actions.current = { onSelect, onCreate, onNavigateMonth }; }, [onSelect, onCreate, onNavigateMonth]);

  function findDay(x: number, y: number) {
    for (const cell of grid.current?.querySelectorAll<HTMLElement>("[data-calendar-day]") || []) {
      const rect = cell.getBoundingClientRect();
      if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return cell.dataset.calendarDay;
    }
  }

  function beginTouch(event: ReactTouchEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.touches.length !== 1) {
      cleanup.current?.();
      suppressClick.current = true;
      if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
      suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; }, 700);
      return;
    }
    const touch = event.changedTouches[0];
    if (!touch) return;
    const anchor = findDay(touch.clientX, touch.clientY);
    if (!anchor) return;
    cleanup.current?.();
    suppressClick.current = false;
    if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
    cleanup.current = startTouchGesture({
      target: window,
      touchId: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      anchor,
      findDay,
      onPreview: (start, end) => setRange(start && end ? dateRange(start, end) : null),
      onCreate: (start, end) => {
        const chosen = dateRange(start, end);
        actions.current.onSelect(chosen.startDate);
        actions.current.onCreate(chosen.startDate, chosen.endDate);
      },
      onNavigateMonth: direction => actions.current.onNavigateMonth(direction),
      onFinish: () => { cleanup.current = null; },
      onSuppressClick: () => {
        suppressClick.current = true;
        if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
        suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; }, 700);
      },
    });
    // Cancellation, scrolling, and normal completion all clear the preview via the session.
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") return;
    if (!event.isPrimary) { cleanup.current?.(); return; }
    if (disabled || event.button !== 0) return;
    // Event bars sit above the day buttons. Their position still maps to a day beneath them.
    const startX = event.clientX, startY = event.clientY;
    const anchor = findDay(startX, startY);
    if (!anchor) return;
    cleanup.current?.();
    suppressClick.current = false;
    if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let end = anchor;
    let moved = false, ended = false;
    const cancel = () => {
      if (ended) return;
      ended = true;
      controller.abort(); cleanup.current = null; setRange(null);
    };
    cleanup.current = cancel;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId || ended) return;
      const dx = next.clientX - startX, dy = next.clientY - startY;
      if (Math.hypot(dx, dy) > 4) moved = true;
      const day = findDay(next.clientX, next.clientY);
      if (day) { end = day; setRange(dateRange(anchor, day)); }
    };
    window.addEventListener("pointermove", move, options);
    window.addEventListener("pointerup", next => {
      if (next.pointerId !== event.pointerId || ended) return;
      const day = findDay(next.clientX, next.clientY);
      if (day) end = day;
      cancel();
      if (moved && end !== anchor && day) {
        suppressClick.current = true;
        suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; }, 700);
        const chosen = dateRange(anchor, end); actions.current.onSelect(chosen.startDate); actions.current.onCreate(chosen.startDate, chosen.endDate);
      }
      cancel();
    }, options);
    window.addEventListener("pointercancel", cancel, options);
    window.addEventListener("blur", cancel, options);
    window.addEventListener("keydown", next => { if (next.key === "Escape") cancel(); }, options);
  }

  return <div ref={grid} className="calendar-grid month-grid" role="grid" aria-label={`${month.slice(0, 7)}のカレンダー`} onPointerDown={beginDrag} onTouchStart={beginTouch} onContextMenu={event => event.preventDefault()} onClickCapture={event => {
    if (!suppressClick.current) return;
    event.preventDefault(); event.stopPropagation(); suppressClick.current = false;
    if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
    suppressTimer.current = null;
  }}>
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
            onClick={event => { if (!suppressClick.current || event.detail === 0) onSelect(day); suppressClick.current = false; }}
            onDoubleClick={event => { if (!disabled && event.button === 0 && !suppressClick.current) { onSelect(day); onCreate(day, day); } }}>
            <span className="day-number">{Number(day.slice(-2))}</span>
          </button>;
        })}
        <div className="week-events">
          {week.segments.filter(segment => segment.lane < 3).map(segment => <button type="button" key={segment.event.id}
            className={`week-event ${segment.startsHere ? "event-start" : "event-continued"} ${segment.endsHere ? "event-end" : "event-continues"}`}
            style={{ gridColumn: `${segment.start + 1} / ${segment.end + 1}`, gridRow: segment.lane + 1, "--member-color": members.find(member => member.id === segment.event.memberId)?.color || "#bd6749" } as CSSProperties}
            title={`${segment.event.title}（${segment.event.startDate} ～ ${segment.event.endDate}）`}
            onClick={() => onSelect(week.days[segment.start])}>
            <span>{segment.event.title}</span>
          </button>)}
          {week.days.map((day, column) => {
            const hidden = week.segments.filter(segment => segment.lane >= 3 && column >= segment.start && column < segment.end).length;
            return hidden ? <button type="button" key={day} className="week-event week-more" style={{ gridColumn: column + 1, gridRow: 4 }} onClick={() => onSelect(day)} aria-label={`${day}のほか${hidden}件の予定を表示`}>ほか{hidden}件</button> : null;
          })}
        </div>
      </div>;
    })}
  </div>;
}
