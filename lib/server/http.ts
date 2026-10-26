export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(data, { status, headers: resultHeaders });
}

export function fail(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  return json({ error: "サーバーでエラーが発生しました。" }, 500);
}

export async function readJson(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(400, "JSON形式で送信してください。");
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new HttpError(413, "送信内容が大きすぎます。");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new HttpError(413, "送信内容が大きすぎます。");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "JSON形式で送信してください。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "送信内容が正しくありません。");
  return value as Record<string, unknown>;
}

export function requireKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new HttpError(400, "送信内容に未対応の項目があります。");
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  let expected: string;
  try {
    expected = new URL(request.url).origin;
  } catch {
    throw new HttpError(403, "この操作は許可されていません。");
  }
  if (!origin || origin !== expected) throw new HttpError(403, "この操作は許可されていません。");
}

export function requiredString(value: unknown, label: string, max: number) {
  if (typeof value !== "string") throw new HttpError(400, `${label}を入力してください。`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) throw new HttpError(400, `${label}は1〜${max}文字で入力してください。`);
  return cleaned;
}

export function validDate(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${label}の日付が正しくありません。`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new HttpError(400, `${label}の日付が正しくありません。`);
  return value;
}

export function requireCalendarId(value: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new HttpError(404, "カレンダーが見つかりません。");
}

export function cookieName(calendarId: string) {
  return `calendar_session_${calendarId}`;
}

export function sessionCookie(request: Request, calendarId: string, secret: string) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName(calendarId)}=${secret}; Path=/api/calendars/${calendarId}; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`;
}

export function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}
