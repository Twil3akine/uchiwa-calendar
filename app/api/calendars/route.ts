import { getDb } from "../../../db";
import { calendars } from "../../../db/schema";
import { fail, json, readJson, requireKeys, requireSameOrigin, requiredString } from "../../../lib/server/http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readJson(request, 2048);
    requireKeys(body, ["name"]);
    const name = requiredString(body.name, "カレンダー名", 40);
    const id = crypto.randomUUID();
    const [calendar] = await getDb().insert(calendars).values({ id, name }).returning({ id: calendars.id, name: calendars.name });
    return json({ calendar }, 201);
  } catch (error) {
    return fail(error);
  }
}
