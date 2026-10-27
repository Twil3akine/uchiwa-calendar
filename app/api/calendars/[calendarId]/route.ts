import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import type { CalendarEvent } from "../../../../lib/calendar-types";
import { calendarEvents, calendars, members } from "../../../../db/schema";
import { cookieName, cookieValue, fail, HttpError, json, requireCalendarId } from "../../../../lib/server/http";
import { findMemberBySecret } from "../../../../lib/server/auth";
import { rateLimit } from "../../../../lib/server/security";
import { expandRecurrence } from "../../../../lib/recurrence.mjs";

type Context = { params: Promise<{ calendarId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    await rateLimit(request, "read");
    const db = getDb();
    const [calendar] = await db.select({ id: calendars.id, name: calendars.name }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
    const [memberRows, eventRows] = await Promise.all([
      db.select({ id: members.id, name: members.name, color: members.color }).from(members).where(eq(members.calendarId, calendarId)).orderBy(asc(members.slot)),
      db.select({ id: calendarEvents.id, memberId: calendarEvents.memberId, title: calendarEvents.title, startDate: calendarEvents.startDate, endDate: calendarEvents.endDate, version: calendarEvents.version, repeatFreq: calendarEvents.repeatFreq, repeatUntil: calendarEvents.repeatUntil, repeatCount: calendarEvents.repeatCount }).from(calendarEvents).where(eq(calendarEvents.calendarId, calendarId)).orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id)),
    ]);
    let me = null;
    const secret = cookieValue(request, cookieName(calendarId));
    if (secret) me = await findMemberBySecret(calendarId, secret);
    const events: CalendarEvent[] = eventRows.flatMap((series): CalendarEvent[] => {
      const recurrence = series.repeatFreq === "weekly" ? { freq: "weekly" as const, until: series.repeatUntil, count: series.repeatCount } : null;
      if (!recurrence) return [{ id: series.id, seriesId: series.id, seriesStartDate: series.startDate, memberId: series.memberId, title: series.title, startDate: series.startDate, endDate: series.endDate, version: series.version, recurrence: null }];
      return expandRecurrence(series.startDate, recurrence).map((date) => ({ id: `${series.id}_${date.replaceAll("-", "")}`, seriesId: series.id, seriesStartDate: series.startDate, memberId: series.memberId, title: series.title, startDate: date, endDate: date, version: series.version, recurrence }));
    });
    return json({ calendar, members: memberRows, events, me });
  } catch (error) {
    return fail(error);
  }
}
