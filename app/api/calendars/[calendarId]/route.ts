import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { calendarEvents, calendars, members } from "../../../../db/schema";
import { cookieName, cookieValue, fail, HttpError, json, requireCalendarId } from "../../../../lib/server/http";
import { findMemberBySecret } from "../../../../lib/server/auth";

type Context = { params: Promise<{ calendarId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    const db = getDb();
    const [calendar] = await db.select({ id: calendars.id, name: calendars.name }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
    const [memberRows, eventRows] = await Promise.all([
      db.select({ id: members.id, name: members.name, color: members.color }).from(members).where(eq(members.calendarId, calendarId)).orderBy(asc(members.slot)),
      db.select({ id: calendarEvents.id, memberId: calendarEvents.memberId, title: calendarEvents.title, startDate: calendarEvents.startDate, endDate: calendarEvents.endDate, version: calendarEvents.version }).from(calendarEvents).where(eq(calendarEvents.calendarId, calendarId)).orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id)),
    ]);
    let me = null;
    const secret = cookieValue(request, cookieName(calendarId));
    if (secret) me = await findMemberBySecret(calendarId, secret);
    return json({ calendar, members: memberRows, events: eventRows, me });
  } catch (error) {
    return fail(error);
  }
}
