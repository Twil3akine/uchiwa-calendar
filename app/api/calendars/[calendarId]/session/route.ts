import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { calendars } from "../../../../../db/schema";
import { findMemberBySecret, validateSecret } from "../../../../../lib/server/auth";
import { fail, HttpError, json, readJson, requireCalendarId, requireKeys, requireSameOrigin, sessionCookie } from "../../../../../lib/server/http";

type Context = { params: Promise<{ calendarId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    const body = await readJson(request, 4096);
    requireKeys(body, ["secret"]);
    const secret = validateSecret(body.secret);
    const [calendar] = await getDb().select({ id: calendars.id }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
    const member = await findMemberBySecret(calendarId, secret);
    if (!member) throw new HttpError(401, "セッションキーが認識されません。");
    return json({ member }, 200, { "Set-Cookie": sessionCookie(request, calendarId, secret) });
  } catch (error) {
    return fail(error);
  }
}
