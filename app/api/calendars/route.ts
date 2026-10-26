import { getDb } from "../../../db";
import { sql } from "drizzle-orm";
import { LIMITS, rateLimit } from "../../../lib/server/security";
import { calendars } from "../../../db/schema";
import { fail, HttpError, json, readJson, requireKeys, requireSameOrigin, requiredString } from "../../../lib/server/http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await rateLimit(request, "create");
    const body = await readJson(request, 2048);
    requireKeys(body, ["name"]);
    const name = requiredString(body.name, "カレンダー名", 40);
    const id = crypto.randomUUID();
    const db = getDb();
    const calendar = await db.get<{ id: string; name: string }>(sql`INSERT INTO calendars (id, name) SELECT ${id}, ${name} WHERE (SELECT COUNT(*) FROM calendars) < ${LIMITS.calendars} RETURNING id, name`);
    if (!calendar) throw new HttpError(409, "カレンダーの作成数が上限に達しています。");
    return json({ calendar }, 201);
  } catch (error) {
    return fail(error);
  }
}
