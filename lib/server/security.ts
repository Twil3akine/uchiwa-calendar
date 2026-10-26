import { env } from "cloudflare:workers";
import { HttpError } from "./http";

export const LIMITS = { calendars: 5000, members: 50, events: 1000, memberEvents: 200 };

/** Cloudflare overwrites this IP header at its edge; never trust a caller-supplied user id. */
export async function rateLimit(request: Request, scope: "create" | "write" | "read") {
  const limiter = scope === "create" ? env.CREATE_LIMIT : scope === "read" ? env.READ_LIMIT : env.WRITE_LIMIT;
  if (!limiter) throw new HttpError(503, "アクセス制限の設定がありません。管理者にお問い合わせください。");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await limiter.limit({ key: `uchiwa:v1:${scope}:${ip}` });
  if (!success) throw new HttpError(429, "操作が多すぎます。1分ほど待ってからお試しください。");
}
