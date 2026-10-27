import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { members } from "../../db/schema";
import { cookieName, cookieValue, HttpError } from "./http";

export async function hashSecret(secret: string) {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateSecret(value: unknown) {
  if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(400, "セッションキーが正しくありません。");
  }
  return value;
}

export function validateViewKey(value: unknown) {
  if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(400, "閲覧キーが正しくありません。");
  }
  return value;
}

export async function findMemberBySecret(calendarId: string, secret: string) {
  const db = getDb();
  const hash = await hashSecret(secret);
  const [member] = await db
    .select({ id: members.id, name: members.name, color: members.color })
    .from(members)
    .where(and(eq(members.calendarId, calendarId), eq(members.secretHash, hash)))
    .limit(1);
  return member ?? null;
}

export async function requireMember(request: Request, calendarId: string) {
  const secret = cookieValue(request, cookieName(calendarId));
  if (!secret) throw new HttpError(401, "参加者のセッションが必要です。");
  const member = await findMemberBySecret(calendarId, secret);
  if (!member) throw new HttpError(401, "参加者のセッションが無効です。");
  return member;
}
