import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { calendarEvents, calendars, members } from "../../../../db/schema";
import { cookieName, cookieValue, fail, HttpError, json, requireCalendarId } from "../../../../lib/server/http";
import { findMemberBySecret, hashSecret } from "../../../../lib/server/auth";
import { rateLimit } from "../../../../lib/server/security";

type Context = { params: Promise<{ calendarId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    await rateLimit(request, "read");
    const db = getDb();
    const [calendar] = await db.select({ id: calendars.id, name: calendars.name, viewKeyHash: calendars.viewKeyHash }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
    const cookieSecret = cookieValue(request, cookieName(calendarId));
    const member = cookieSecret ? await findMemberBySecret(calendarId, cookieSecret) : null;
    const suppliedViewKey = request.headers.get("X-View-Key");
    const keyMatches = calendar.viewKeyHash === null || (suppliedViewKey !== null && await hashSecret(suppliedViewKey) === calendar.viewKeyHash);
    if (calendar.viewKeyHash !== null && !member && !keyMatches) throw new HttpError(404, "カレンダーが見つかりません。");
    const [memberRows, eventRows] = await Promise.all([
      db.select({ id: members.id, name: members.name, color: members.color }).from(members).where(eq(members.calendarId, calendarId)).orderBy(asc(members.slot)),
      db.select({ id: calendarEvents.id, memberId: calendarEvents.memberId, title: calendarEvents.title, startDate: calendarEvents.startDate, endDate: calendarEvents.endDate, version: calendarEvents.version }).from(calendarEvents).where(eq(calendarEvents.calendarId, calendarId)).orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id)),
    ]);
    const me = member;
    return json({ calendar: { id: calendar.id, name: calendar.name, viewKeyRequired: calendar.viewKeyHash !== null }, members: memberRows, events: eventRows, me });
  } catch (error) {
    return fail(error);
  }
}
