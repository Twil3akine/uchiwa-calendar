import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { calendars, members } from "../../../../../db/schema";
import { LIMITS, rateLimit } from "../../../../../lib/server/security";
import { findMemberBySecret, hashSecret, requireMember, validateSecret } from "../../../../../lib/server/auth";
import { fail, HttpError, json, readJson, requireCalendarId, requireKeys, requireSameOrigin, requiredString, sessionCookie } from "../../../../../lib/server/http";
import { MEMBER_COLORS } from "../../../../../lib/member-colors";

type Context = { params: Promise<{ calendarId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    const body = await readJson(request, 4096);
    requireKeys(body, ["name", "secret"]);
    const name = requiredString(body.name, "お名前", 40);
    const secret = validateSecret(body.secret);
    const viewKey = request.headers.get("X-View-Key");
    const db = getDb();
    const [calendar] = await db.select({ id: calendars.id }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!calendar) throw new HttpError(404, "カレンダーが見つかりません。");
    const secretHash = await hashSecret(secret);
    const existing = await findMemberBySecret(calendarId, secret);
    if (existing) {
      if (existing.name !== name) throw new HttpError(409, "このセッションキーは別のお名前で登録されています。");
      return json({ member: existing }, 200, { "Set-Cookie": sessionCookie(request, calendarId, secret) });
    }
    const id = crypto.randomUUID();
    const colorCase = sql`CASE ((SELECT COUNT(*) FROM members WHERE calendar_id = ${calendarId}) % ${MEMBER_COLORS.length}) ${sql.join(MEMBER_COLORS.map((color, index) => sql`WHEN ${index} THEN ${color}`), sql` `)} END`;
    try {
      const viewHash = viewKey ? await hashSecret(viewKey) : "";
      await db.run(sql`INSERT INTO members (member_id, calendar_id, name, color, secret_hash) SELECT ${id}, ${calendarId}, ${name}, ${colorCase}, ${secretHash} WHERE (SELECT COUNT(*) FROM members WHERE calendar_id = ${calendarId}) < ${LIMITS.members} AND EXISTS (SELECT 1 FROM calendars WHERE id = ${calendarId} AND (view_key_hash IS NULL OR view_key_hash = ${viewHash}))`);
    } catch (error) {
      // A simultaneous retry can race on the calendar/secret unique index.
      const raced = await findMemberBySecret(calendarId, secret);
      if (!raced) throw error;
      if (raced.name !== name) throw new HttpError(409, "このセッションキーは別のお名前で登録されています。");
      return json({ member: raced }, 200, { "Set-Cookie": sessionCookie(request, calendarId, secret) });
    }
    const member = await findMemberBySecret(calendarId, secret);
    if (!member) {
      const [stillExists] = await db.select({ viewKeyHash: calendars.viewKeyHash }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
      if (!stillExists || (stillExists.viewKeyHash !== null && (!viewKey || await hashSecret(viewKey) !== stillExists.viewKeyHash))) throw new HttpError(404, "カレンダーが見つかりません。");
      throw new HttpError(409, `参加者は${LIMITS.members}人までです。`);
    }
    return json({ member }, 201, { "Set-Cookie": sessionCookie(request, calendarId, secret) });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    const member = await requireMember(request, calendarId);
    const body = await readJson(request, 4096);
    requireKeys(body, ["color"]);
    if (typeof body.color !== "string" || !MEMBER_COLORS.includes(body.color as (typeof MEMBER_COLORS)[number])) {
      throw new HttpError(400, "色を選び直してください。");
    }
    const [updated] = await getDb().update(members)
      .set({ color: body.color })
      .where(and(eq(members.id, member.id), eq(members.calendarId, calendarId)))
      .returning({ id: members.id, name: members.name, color: members.color });
    if (!updated) throw new HttpError(401, "参加者のセッションが無効です。");
    return json({ member: updated });
  } catch (error) {
    return fail(error);
  }
}
