import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { calendars } from "../../../../../db/schema";
import { hashSecret, requireMember, validateViewKey } from "../../../../../lib/server/auth";
import { fail, HttpError, json, readJson, requireCalendarId, requireKeys, requireSameOrigin } from "../../../../../lib/server/http";
import { rateLimit } from "../../../../../lib/server/security";

type Context = { params: Promise<{ calendarId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "write");
    const { calendarId } = await params;
    requireCalendarId(calendarId);
    await requireMember(request, calendarId);
    const body = await readJson(request, 512);
    requireKeys(body, ["confirm", "key", "expectedKey"]);
    if (body.confirm !== true) throw new HttpError(400, "共有リンクの再発行を確認してください。");
    const key = validateViewKey(body.key);
    const expectedKey = body.expectedKey === undefined ? undefined : validateViewKey(body.expectedKey);
    const db = getDb();
    const newHash = await hashSecret(key);
    const conditions = [eq(calendars.id, calendarId)];
    if (expectedKey !== undefined) conditions.push(eq(calendars.viewKeyHash, await hashSecret(expectedKey)));
    else conditions.push(isNull(calendars.viewKeyHash));
    const changed = await db.update(calendars).set({ viewKeyHash: newHash }).where(and(...conditions)).returning({ id: calendars.id });
    if (!changed.length) throw new HttpError(409, "共有リンクが別の端末で更新されています。最新の状態を読み直してください。");
    return json({ ok: true }, 200, { "Cache-Control": "no-store" });
  } catch (error) { return fail(error); }
}
