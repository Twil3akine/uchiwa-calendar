import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { calendars, members } from "../../../../../db/schema";
import { rateLimit } from "../../../../../lib/server/security";
import { findMemberBySecret, hashSecret, requireMember, validateSecret } from "../../../../../lib/server/auth";
import { cookieName, cookieValue, fail, HttpError, json, readJson, requireCalendarId, requireKeys, requireSameOrigin, sessionCookie } from "../../../../../lib/server/http";

type Context = { params: Promise<{ calendarId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
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

/** Rotate the one-way verifier atomically: all previous links and cookies stop working. */
export async function PATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    const member = await requireMember(request, calendarId);
    const body = await readJson(request, 128);
    requireKeys(body, ["confirm", "secret"]);
    if (body.confirm !== true) throw new HttpError(400, "個人リンクの再発行を確認してください。");
    const previous = cookieValue(request, cookieName(calendarId))!;
    const secret = validateSecret(body.secret);
    if (secret.length !== 43) throw new HttpError(400, "新しい個人リンクのキーが正しくありません。");
    if (secret === previous) return json({ member, secret }, 200, { "Set-Cookie": sessionCookie(request, calendarId, secret) });
    const changed = await getDb().update(members).set({ secretHash: await hashSecret(secret) })
      .where(and(eq(members.id, member.id), eq(members.calendarId, calendarId), eq(members.secretHash, await hashSecret(previous))))
      .returning({ id: members.id });
    if (!changed.length) throw new HttpError(409, "ほかの端末で再発行されました。最新の個人リンクから開き直してください。");
    return json({ member, secret }, 200, { "Set-Cookie": sessionCookie(request, calendarId, secret), "Cache-Control": "no-store" });
  } catch (error) { return fail(error); }
}
