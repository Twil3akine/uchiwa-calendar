import { addCalendarEvent } from "../../../../../lib/server/calendar-service";
import { requireMember } from "../../../../../lib/server/auth";
import { rateLimit } from "../../../../../lib/server/security";
import { fail, HttpError, json, readJson, requireCalendarId, requireKeys, requireSameOrigin, requiredString, validDate } from "../../../../../lib/server/http";

type Context = { params: Promise<{ calendarId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    const body = await readJson(request, 4096);
    requireKeys(body, ["id", "title", "startDate", "endDate", "recurrence"]);
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) throw new HttpError(400, "予定IDが正しくありません。");
    const title = requiredString(body.title, "予定名", 100);
    const startDate = validDate(body.startDate, "開始");
    const endDate = validDate(body.endDate, "終了");
    if (endDate < startDate) throw new HttpError(400, "終了日は開始日以降にしてください。");
    const member = await requireMember(request, calendarId);
    const result = await addCalendarEvent({ calendarId, memberId: member.id }, { id: body.id, title, startDate, endDate, recurrence: body.recurrence });
    return json({ event: result.event }, result.created ? 201 : 200);
  } catch (error) {
    return fail(error);
  }
}
