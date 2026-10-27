import { and, asc, eq, sql } from "drizzle-orm";
import type { CalendarEvent } from "../calendar-types";
import { expandRecurrence, normalizeRecurrence, type RecurrenceRule } from "../recurrence.mjs";
import { getDb } from "../../db";
import { calendarEvents, calendars, members } from "../../db/schema";
import { LIMITS } from "./security";
import { HttpError } from "./http";

export type CalendarActor = { calendarId: string; memberId: string };
export type NewEventInput = { id: string; title: string; startDate: string; endDate: string; recurrence?: unknown };
type EventRow = {
  id: string;
  memberId: string;
  title: string;
  startDate: string;
  endDate: string;
  version: number;
  repeatFreq: string | null;
  repeatUntil: string | null;
  repeatCount: number | null;
  updatedAt?: string;
  memberName?: string;
};

function rowRecurrence(row: Pick<EventRow, "repeatFreq" | "repeatUntil" | "repeatCount">): RecurrenceRule | null {
  return row.repeatFreq === "weekly" ? { freq: "weekly", until: row.repeatUntil, count: row.repeatCount } : null;
}

function eventResult(row: EventRow) {
  const recurrence = rowRecurrence(row);
  return {
    id: row.id,
    seriesId: row.id,
    seriesStartDate: row.startDate,
    memberId: row.memberId,
    title: row.title,
    startDate: row.startDate,
    endDate: row.endDate,
    version: row.version,
    repeatFreq: row.repeatFreq,
    repeatUntil: row.repeatUntil,
    repeatCount: row.repeatCount,
    recurrence,
  };
}

function isSameEvent(row: EventRow & { calendarId: string }, actor: CalendarActor, input: NewEventInput, recurrence: RecurrenceRule | null) {
  const current = rowRecurrence(row);
  return row.calendarId === actor.calendarId && row.memberId === actor.memberId && row.title === input.title
    && row.startDate === input.startDate && row.endDate === input.endDate
    && current?.freq === recurrence?.freq && current?.until === recurrence?.until && current?.count === recurrence?.count;
}

function normalizeEventRecurrence(value: unknown, startDate: string, endDate: string) {
  let recurrence: RecurrenceRule | null;
  try { recurrence = normalizeRecurrence(value, startDate); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "繰り返しの規則が正しくありません。"); }
  if (recurrence && endDate !== startDate) throw new HttpError(400, "繰り返し予定は開始日と終了日を同じ日にしてください。");
  return recurrence;
}

const storedEventCost = sql`CASE WHEN repeat_freq = 'weekly' THEN
  CASE WHEN repeat_count IS NOT NULL AND repeat_until IS NOT NULL THEN MIN(repeat_count, CAST((julianday(repeat_until) - julianday(start_date)) / 7 AS INTEGER) + 1)
       WHEN repeat_count IS NOT NULL THEN repeat_count
       WHEN repeat_until IS NOT NULL THEN CAST((julianday(repeat_until) - julianday(start_date)) / 7 AS INTEGER) + 1
       ELSE 1 END
  ELSE 1 END`;

export async function addCalendarEvent(actor: CalendarActor, input: NewEventInput) {
  const db = getDb();
  const [calendar] = await db.select({ id: calendars.id }).from(calendars).where(eq(calendars.id, actor.calendarId)).limit(1);
  if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
  const recurrence = normalizeEventRecurrence(input.recurrence, input.startDate, input.endDate);
  const repeatFreq = recurrence?.freq ?? null;
  const repeatUntil = recurrence?.until ?? null;
  const repeatCount = recurrence?.count ?? null;
  const eventCost = recurrence ? expandRecurrence(input.startDate, recurrence).length : 1;
  const [existing] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, input.id)).limit(1);
  if (existing) {
    if (isSameEvent(existing as EventRow & { calendarId: string }, actor, input, recurrence)) return { event: eventResult(existing as EventRow), created: false };
    throw new HttpError(409, "この予定IDはすでに使用されています。");
  }
  try {
    const event = await db.get<EventRow>(sql`INSERT INTO calendar_events (id, calendar_id, member_id, title, start_date, end_date, repeat_freq, repeat_until, repeat_count)
      SELECT ${input.id}, ${actor.calendarId}, ${actor.memberId}, ${input.title}, ${input.startDate}, ${input.endDate}, ${repeatFreq}, ${repeatUntil}, ${repeatCount}
      WHERE (SELECT COALESCE(SUM(${storedEventCost}), 0) FROM calendar_events WHERE calendar_id = ${actor.calendarId}) + ${eventCost} <= ${LIMITS.events}
        AND (SELECT COALESCE(SUM(${storedEventCost}), 0) FROM calendar_events WHERE calendar_id = ${actor.calendarId} AND member_id = ${actor.memberId}) + ${eventCost} <= ${LIMITS.memberEvents}
      RETURNING id, calendar_id AS calendarId, member_id AS memberId, title, start_date AS startDate, end_date AS endDate, version, repeat_freq AS repeatFreq, repeat_until AS repeatUntil, repeat_count AS repeatCount`);
    if (!event) throw new HttpError(409, `予定数の上限（カレンダー${LIMITS.events}件・1人${LIMITS.memberEvents}件）に達しています。`);
    return { event: eventResult(event), created: true };
  } catch (error) {
    const [raced] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, input.id)).limit(1);
    if (!raced) throw error;
    if (isSameEvent(raced as EventRow & { calendarId: string }, actor, input, recurrence)) return { event: eventResult(raced as EventRow), created: false };
    throw new HttpError(409, "この予定IDはすでに使用されています。");
  }
}

export async function listCalendarEvents(actor: CalendarActor, range?: { from?: string; to?: string }) {
  const rows = await getDb().select({
    id: calendarEvents.id,
    memberId: calendarEvents.memberId,
    title: calendarEvents.title,
    startDate: calendarEvents.startDate,
    endDate: calendarEvents.endDate,
    version: calendarEvents.version,
    repeatFreq: calendarEvents.repeatFreq,
    repeatUntil: calendarEvents.repeatUntil,
    repeatCount: calendarEvents.repeatCount,
    updatedAt: calendarEvents.updatedAt,
    memberName: members.name,
  }).from(calendarEvents).innerJoin(members, eq(calendarEvents.memberId, members.id))
    .where(eq(calendarEvents.calendarId, actor.calendarId))
    .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id));
  const events: (CalendarEvent & { memberName: string; updatedAt: string })[] = [];
  for (const row of rows) {
    const recurrence = rowRecurrence(row);
    const dates = recurrence ? expandRecurrence(row.startDate, recurrence) : [row.startDate];
    for (const date of dates) {
      const endDate = recurrence ? date : row.endDate;
      if (range?.from && endDate < range.from) continue;
      if (range?.to && date > range.to) continue;
      events.push({
        id: recurrence ? `${row.id}_${date.replaceAll("-", "")}` : row.id,
        seriesId: row.id,
        seriesStartDate: row.startDate,
        memberId: row.memberId,
        memberName: row.memberName,
        title: row.title,
        startDate: date,
        endDate,
        version: row.version,
        recurrence,
        updatedAt: row.updatedAt,
      });
    }
  }
  return events.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
}

export async function updateCalendarEvent(actor: CalendarActor, eventId: string, input: { title: string; startDate: string; endDate: string; version: number; recurrence?: unknown }) {
  const db = getDb();
  const [previous] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.calendarId, actor.calendarId))).limit(1);
  if (!previous) throw new HttpError(404, "予定が見つかりません。");
  if (previous.memberId !== actor.memberId) throw new HttpError(403, "この予定を変更する権限がありません。");
  if (previous.version !== input.version) throw new HttpError(409, "予定がほかの操作で更新されました。最新の内容を読み込んでください。");
  const previousRecurrence = rowRecurrence(previous as EventRow);
  const value = Object.hasOwn(input, "recurrence") ? input.recurrence : previousRecurrence;
  const recurrence = normalizeEventRecurrence(value, input.startDate, input.endDate);
  const oldCost = previousRecurrence ? expandRecurrence(previous.startDate, previousRecurrence).length : 1;
  const newCost = recurrence ? expandRecurrence(input.startDate, recurrence).length : 1;
  const [event] = await db.update(calendarEvents).set({
    title: input.title,
    startDate: input.startDate,
    endDate: input.endDate,
    repeatFreq: recurrence?.freq ?? null,
    repeatUntil: recurrence?.until ?? null,
    repeatCount: recurrence?.count ?? null,
    version: input.version + 1,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(calendarEvents.id, eventId),
    eq(calendarEvents.calendarId, actor.calendarId),
    eq(calendarEvents.memberId, actor.memberId),
    eq(calendarEvents.version, input.version),
    sql`(
      ((SELECT COALESCE(SUM(${storedEventCost}), 0) FROM calendar_events WHERE calendar_id = ${actor.calendarId} AND id <> ${eventId}) + ${newCost} <= ${LIMITS.events}
        OR ${newCost} <= ${oldCost})
      AND ((SELECT COALESCE(SUM(${storedEventCost}), 0) FROM calendar_events WHERE calendar_id = ${actor.calendarId} AND member_id = ${actor.memberId} AND id <> ${eventId}) + ${newCost} <= ${LIMITS.memberEvents}
        OR ${newCost} <= ${oldCost})
    )`,
  ))
    .returning({ id: calendarEvents.id, memberId: calendarEvents.memberId, title: calendarEvents.title, startDate: calendarEvents.startDate, endDate: calendarEvents.endDate, version: calendarEvents.version, repeatFreq: calendarEvents.repeatFreq, repeatUntil: calendarEvents.repeatUntil, repeatCount: calendarEvents.repeatCount });
  if (!event) {
    const [latest] = await db.select({ memberId: calendarEvents.memberId, version: calendarEvents.version }).from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.calendarId, actor.calendarId))).limit(1);
    if (!latest || latest.memberId !== actor.memberId || latest.version !== input.version) {
      throw new HttpError(409, "予定がほかの操作で更新されました。最新の内容を読み込んでください。");
    }
    throw new HttpError(409, `予定数の上限（カレンダー${LIMITS.events}件・1人${LIMITS.memberEvents}件）を超えるため、繰り返し回数を増やせません。回数を減らしてから保存してください。`);
  }
  return eventResult(event as EventRow);
}

export async function deleteCalendarEvent(actor: CalendarActor, eventId: string, version: number) {
  const db = getDb();
  const [previous] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.calendarId, actor.calendarId))).limit(1);
  if (!previous) throw new HttpError(404, "予定が見つかりません。");
  if (previous.memberId !== actor.memberId) throw new HttpError(403, "この予定を変更する権限がありません。");
  if (previous.version !== version) throw new HttpError(409, "予定がほかの操作で更新されました。最新の内容を読み込んでください。");
  const deleted = await db.delete(calendarEvents).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.calendarId, actor.calendarId), eq(calendarEvents.memberId, actor.memberId), eq(calendarEvents.version, version))).returning({ id: calendarEvents.id });
  if (!deleted.length) throw new HttpError(409, "予定がほかの操作で更新されました。最新の内容を読み込んでください。");
}
