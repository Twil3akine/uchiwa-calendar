import { deleteCalendarEvent, updateCalendarEvent } from "../../../../../../lib/server/calendar-service";
import { requireMember } from "../../../../../../lib/server/auth";
import { rateLimit } from "../../../../../../lib/server/security";
import { fail, HttpError, json, readJson, requireCalendarId, requireKeys, requireSameOrigin, requiredString, validDate } from "../../../../../../lib/server/http";

type Context = { params: Promise<{ calendarId: string; eventId: string }> };

function versionValue(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new HttpError(400, "予定のバージョンが正しくありません。");
  return value as number;
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
    const { calendarId, eventId } = await params;
    requireCalendarId(calendarId);
    const body = await readJson(request, 4096);
    requireKeys(body, ["title", "startDate", "endDate", "version", "recurrence"]);
    const title = requiredString(body.title, "予定名", 100);
    const startDate = validDate(body.startDate, "開始");
    const endDate = validDate(body.endDate, "終了");
    if (endDate < startDate) throw new HttpError(400, "終了日は開始日以降にしてください。");
    const version = versionValue(body.version);
    const member = await requireMember(request, calendarId);
    const event = await updateCalendarEvent({ calendarId, memberId: member.id }, eventId, {
      title, startDate, endDate, version,
      ...(Object.hasOwn(body, "recurrence") ? { recurrence: body.recurrence } : {}),
    });
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
