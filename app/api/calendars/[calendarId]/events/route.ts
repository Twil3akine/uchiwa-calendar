import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { calendarEvents, calendars } from "../../../../../db/schema";
import { requireMember } from "../../../../../lib/server/auth";
import { fail, HttpError, json, readJson, requireCalendarId, requireKeys, requireSameOrigin, requiredString, validDate } from "../../../../../lib/server/http";

type Context = { params: Promise<{ calendarId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    const body = await readJson(request, 4096);
    requireKeys(body, ["id", "title", "startDate", "endDate"]);
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) throw new HttpError(400, "予定IDが正しくありません。");
    const title = requiredString(body.title, "予定名", 100);
    const startDate = validDate(body.startDate, "開始");
    const endDate = validDate(body.endDate, "終了");
    if (endDate < startDate) throw new HttpError(400, "終了日は開始日以降にしてください。");
    const member = await requireMember(request, calendarId);
    const db = getDb();
    const [calendar] = await db.select({ id: calendars.id }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
    const [existing] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, body.id)).limit(1);
    if (existing) {
      if (existing.calendarId === calendarId && existing.memberId === member.id && existing.title === title && existing.startDate === startDate && existing.endDate === endDate) {
        return json({ event: { id: existing.id, memberId: existing.memberId, title: existing.title, startDate: existing.startDate, endDate: existing.endDate, version: existing.version } });
      }
      throw new HttpError(409, "この予定IDはすでに使用されています。");
    }
    let event;
    try {
      [event] = await db.insert(calendarEvents).values({ id: body.id, calendarId, memberId: member.id, title, startDate, endDate }).returning({ id: calendarEvents.id, memberId: calendarEvents.memberId, title: calendarEvents.title, startDate: calendarEvents.startDate, endDate: calendarEvents.endDate, version: calendarEvents.version });
    } catch (error) {
      // Two retries can race after both observe an unused id. Re-read the winner
      // and preserve the same idempotency behavior as the non-racing path.
      const [raced] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, body.id)).limit(1);
      if (!raced) throw error;
      if (raced.calendarId === calendarId && raced.memberId === member.id && raced.title === title && raced.startDate === startDate && raced.endDate === endDate) {
        return json({ event: { id: raced.id, memberId: raced.memberId, title: raced.title, startDate: raced.startDate, endDate: raced.endDate, version: raced.version } });
      }
      throw new HttpError(409, "この予定IDはすでに使用されています。");
    }
    return json({ event }, 201);
  } catch (error) {
    return fail(error);
  }
}
