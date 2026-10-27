import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { calendarEvents } from "../../../../../../db/schema";
import { requireMember } from "../../../../../../lib/server/auth";
import { rateLimit } from "../../../../../../lib/server/security";
import { deleteCalendarEvent } from "../../../../../../lib/server/calendar-service";
import { fail, HttpError, json, readJson, requireCalendarId, requireKeys, requireSameOrigin, requiredString, validDate } from "../../../../../../lib/server/http";

type Context = { params: Promise<{ calendarId: string; eventId: string }> };

function versionValue(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new HttpError(400, "予定のバージョンが正しくありません。");
  return value as number;
}

async function ownedEvent(calendarId: string, eventId: string, memberId: string) {
  const [event] = await getDb().select().from(calendarEvents).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.calendarId, calendarId))).limit(1);
  if (!event) throw new HttpError(404, "予定が見つかりません。");
  if (event.memberId !== memberId) throw new HttpError(403, "この予定を変更する権限がありません。");
  return event;
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
    const { calendarId, eventId } = await params;
    requireCalendarId(calendarId);
    const body = await readJson(request, 4096);
    requireKeys(body, ["title", "startDate", "endDate", "version"]);
    const title = requiredString(body.title, "予定名", 100);
    const startDate = validDate(body.startDate, "開始");
    const endDate = validDate(body.endDate, "終了");
    if (endDate < startDate) throw new HttpError(400, "終了日は開始日以降にしてください。");
    const version = versionValue(body.version);
    const member = await requireMember(request, calendarId);
    const previous = await ownedEvent(calendarId, eventId, member.id);
    if (previous.version !== version) throw new HttpError(409, "予定がほかの操作で更新されました。最新の内容を読み込んでください。");
    const [event] = await getDb().update(calendarEvents).set({ title, startDate, endDate, version: version + 1, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.memberId, member.id), eq(calendarEvents.version, version))).returning({ id: calendarEvents.id, memberId: calendarEvents.memberId, title: calendarEvents.title, startDate: calendarEvents.startDate, endDate: calendarEvents.endDate, version: calendarEvents.version });
    if (!event) throw new HttpError(409, "予定がほかの操作で更新されました。最新の内容を読み込んでください。");
    return json({ event });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
    const { calendarId, eventId } = await params;
    requireCalendarId(calendarId);
    const body = await readJson(request, 2048);
    requireKeys(body, ["version"]);
    const version = versionValue(body.version);
    const member = await requireMember(request, calendarId);
    await deleteCalendarEvent({ calendarId, memberId: member.id }, eventId, version);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
