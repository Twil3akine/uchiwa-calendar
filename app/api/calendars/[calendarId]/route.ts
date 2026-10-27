import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { calendars, members } from "../../../../db/schema";
import { listCalendarEvents } from "../../../../lib/server/calendar-service";
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
    const secret = cookieValue(request, cookieName(calendarId));
    const me = secret ? await findMemberBySecret(calendarId, secret) : null;
    const suppliedViewKey = request.headers.get("X-View-Key");
    const keyMatches = calendar.viewKeyHash === null || (suppliedViewKey !== null && await hashSecret(suppliedViewKey) === calendar.viewKeyHash);
    if (calendar.viewKeyHash !== null && !me && !keyMatches) throw new HttpError(404, "カレンダーが見つかりません。");
    const [memberRows, events] = await Promise.all([
      db.select({ id: members.id, name: members.name, color: members.color }).from(members).where(eq(members.calendarId, calendarId)).orderBy(asc(members.slot)),
      listCalendarEvents({ calendarId, memberId: me?.id ?? "" }),
    ]);
    return json({ calendar: { id: calendar.id, name: calendar.name, viewKeyRequired: calendar.viewKeyHash !== null }, members: memberRows, events, me });
  } catch (error) {
    return fail(error);
  }
}
