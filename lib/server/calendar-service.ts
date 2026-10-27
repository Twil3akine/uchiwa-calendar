import { and, asc, eq, lte, gte, sql } from "drizzle-orm";
import type { CalendarEvent } from "../calendar-types";
import { getDb } from "../../db";
import { calendarEvents, calendars } from "../../db/schema";
import { LIMITS } from "./security";
import { HttpError } from "./http";

export type CalendarActor = { calendarId: string; memberId: string };
export type NewEventInput = { id: string; title: string; startDate: string; endDate: string };

export async function addCalendarEvent(actor: CalendarActor, input: NewEventInput) {
  const db = getDb();
  const [calendar] = await db.select({ id: calendars.id }).from(calendars).where(eq(calendars.id, actor.calendarId)).limit(1);
  if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
  const [existing] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, input.id)).limit(1);
  if (existing) {
    if (isSameEvent(existing, actor, input)) return { event: eventResult(existing), created: false };
    throw new HttpError(409, "この予定IDはすでに使用されています。");
  }
  try {
    const event = await db.get<CalendarEvent>(sql`INSERT INTO calendar_events (id, calendar_id, member_id, title, start_date, end_date)
      SELECT ${input.id}, ${actor.calendarId}, ${actor.memberId}, ${input.title}, ${input.startDate}, ${input.endDate}
      WHERE (SELECT COUNT(*) FROM calendar_events WHERE calendar_id = ${actor.calendarId}) < ${LIMITS.events}
        AND (SELECT COUNT(*) FROM calendar_events WHERE calendar_id = ${actor.calendarId} AND member_id = ${actor.memberId}) < ${LIMITS.memberEvents}
      RETURNING id, member_id AS memberId, title, start_date AS startDate, end_date AS endDate, version`);
    if (!event) throw new HttpError(409, `予定数の上限（カレンダー${LIMITS.events}件・1人${LIMITS.memberEvents}件）に達しています。`);
    return { event, created: true };
  } catch (error) {
    // Concurrent retries can collide on the primary key; re-read to preserve idempotency.
    const [raced] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, input.id)).limit(1);
    if (!raced) throw error;
    if (isSameEvent(raced, actor, input)) return { event: eventResult(raced), created: false };
    throw new HttpError(409, "この予定IDはすでに使用されています。");
  }
}

export async function listCalendarEvents(actor: CalendarActor, range?: { from?: string; to?: string }) {
  const conditions = [eq(calendarEvents.calendarId, actor.calendarId)];
  if (range?.from) conditions.push(gte(calendarEvents.endDate, range.from));
  if (range?.to) conditions.push(lte(calendarEvents.startDate, range.to));
  return getDb().select({ id: calendarEvents.id, memberId: calendarEvents.memberId, title: calendarEvents.title, startDate: calendarEvents.startDate, endDate: calendarEvents.endDate, version: calendarEvents.version })
    .from(calendarEvents).where(and(...conditions)).orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id));
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

function isSameEvent(row: { calendarId: string; memberId: string; title: string; startDate: string; endDate: string }, actor: CalendarActor, input: NewEventInput) {
  return row.calendarId === actor.calendarId && row.memberId === actor.memberId && row.title === input.title && row.startDate === input.startDate && row.endDate === input.endDate;
}

function eventResult(row: { id: string; memberId: string; title: string; startDate: string; endDate: string; version: number }) {
  return { id: row.id, memberId: row.memberId, title: row.title, startDate: row.startDate, endDate: row.endDate, version: row.version };
}
