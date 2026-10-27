import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { calendarEvents, calendars, members } from "../../../../../db/schema";
import { generateIcalFeed } from "../../../../../lib/ical";
import { hashSecret, validateViewKey } from "../../../../../lib/server/auth";
import { fail, HttpError, requireCalendarId } from "../../../../../lib/server/http";
import { rateLimit } from "../../../../../lib/server/security";

type Context = { params: Promise<{ calendarId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    await rateLimit(request, "read");
    const db = getDb();
    const [calendar] = await db.select({ id: calendars.id, name: calendars.name, viewKeyHash: calendars.viewKeyHash }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
    if (calendar.viewKeyHash !== null) {
      const suppliedKey = new URL(request.url).searchParams.get("k");
      if (!suppliedKey) throw new HttpError(404, "カレンダーが見つかりません。");
      try { validateViewKey(suppliedKey); } catch { throw new HttpError(404, "カレンダーが見つかりません。"); }
      if (await hashSecret(suppliedKey) !== calendar.viewKeyHash) throw new HttpError(404, "カレンダーが見つかりません。");
    }
    const rows = await db.select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startDate: calendarEvents.startDate,
      endDate: calendarEvents.endDate,
      updatedAt: calendarEvents.updatedAt,
      memberName: members.name,
    }).from(calendarEvents)
      .innerJoin(members, eq(calendarEvents.memberId, members.id))
      .where(eq(calendarEvents.calendarId, calendarId))
      .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id));
    const body = generateIcalFeed({ calendarName: calendar.name, events: rows });
    return new Response(body, { headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    return fail(error);
  }
}
