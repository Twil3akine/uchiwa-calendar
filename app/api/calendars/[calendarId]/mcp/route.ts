import { addCalendarEvent, deleteCalendarEvent, listCalendarEvents } from "../../../../../lib/server/calendar-service";
import { findMemberBySecret } from "../../../../../lib/server/auth";
import { rateLimit } from "../../../../../lib/server/security";
import { HttpError, requireCalendarId, requiredString, validDate } from "../../../../../lib/server/http";

type Context = { params: Promise<{ calendarId: string }> };
type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 8192;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const tools = [
  { name: "list_events", description: "カレンダーの予定を一覧します。from/toは予定期間と重なる日付範囲です。", inputSchema: { type: "object", properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } }, additionalProperties: false } },
  { name: "add_event", description: "自分の予定を登録します。毎週繰り返す場合はrecurrenceにfreq=weeklyとuntilまたはcountを指定します。eventIdは再送時にも同じUUIDを指定してください。", inputSchema: { type: "object", required: ["eventId", "title", "startDate", "endDate"], properties: { eventId: { type: "string", format: "uuid" }, title: { type: "string" }, startDate: { type: "string", format: "date" }, endDate: { type: "string", format: "date" }, recurrence: { type: "object", properties: { freq: { type: "string", enum: ["weekly"] }, until: { type: ["string", "null"], format: "date" }, count: { type: ["integer", "null"], minimum: 2, maximum: 53 } }, required: ["freq"], additionalProperties: false } }, additionalProperties: false } },
  { name: "delete_event", description: "自分の予定または繰り返しシリーズ全体を削除します。繰り返し予定の場合、一覧の出現idではなくseriesIdをeventIdに指定し、版番号を添えてください。", inputSchema: { type: "object", required: ["eventId", "version"], properties: { eventId: { type: "string", format: "uuid" }, version: { type: "integer", minimum: 1 } }, additionalProperties: false } },
];

function response(body: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Referrer-Policy", "no-referrer");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers: responseHeaders });
}

function rpcError(id: unknown, code: number, message: string) {
  return response({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function methodOf(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RpcRequest).method : undefined;
}

function classify(value: unknown): "read" | "write" {
  if (Array.isArray(value)) return "read";
  if (!value || typeof value !== "object") return "read";
  const request = value as RpcRequest;
  const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const toolName = params.name;
  return request.method === "tools/call" && (toolName === "add_event" || toolName === "delete_event") ? "write" : "read";
}

async function readBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) throw new HttpError(413, "送信内容が大きすぎます。");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          throw new HttpError(413, "送信内容が大きすぎます。");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function originAllowed(request: Request) {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try { return origin === new URL(request.url).origin; } catch { return false; }
}

function toolResult(id: unknown, data: unknown) {
  const text = JSON.stringify(data);
  return response({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], structuredContent: data } });
}

function toolFailure(id: unknown, message: string) {
  return response({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } });
}

function paramsObject(params: unknown) {
  if (params === undefined) return {};
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new RpcParamsError();
  return params as Record<string, unknown>;
}

class RpcParamsError extends Error {}
class ToolExecutionError extends Error {}

function validateEventId(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) throw new ToolExecutionError("予定IDはUUID形式で指定してください。");
  return value;
}

async function callTool(name: unknown, rawArgs: unknown, calendarId: string, memberId: string) {
  if (typeof name !== "string") throw new RpcParamsError();
  const args = paramsObject(rawArgs);
  const allowed = name === "list_events" ? ["from", "to"] : name === "add_event" ? ["eventId", "title", "startDate", "endDate", "recurrence"] : name === "delete_event" ? ["eventId", "version"] : null;
  if (!allowed) throw new ToolExecutionError("指定されたツールはありません。");
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new ToolExecutionError("未対応の引数があります。");
  if (name === "list_events") {
    const from = args.from === undefined ? undefined : validDate(args.from, "開始");
    const to = args.to === undefined ? undefined : validDate(args.to, "終了");
    if (from && to && to < from) throw new ToolExecutionError("終了日は開始日以降にしてください。");
    const events = await listCalendarEvents({ calendarId, memberId }, { from, to });
    return { events };
  }
  if (name === "add_event") {
    const eventId = validateEventId(args.eventId);
    const title = requiredString(args.title, "予定名", 100);
    const startDate = validDate(args.startDate, "開始");
    const endDate = validDate(args.endDate, "終了");
    if (endDate < startDate) throw new ToolExecutionError("終了日は開始日以降にしてください。");
    const created = await addCalendarEvent({ calendarId, memberId }, { id: eventId, title, startDate, endDate, recurrence: args.recurrence });
    return { event: created.event };
  }
  const eventId = validateEventId(args.eventId);
  if (!Number.isSafeInteger(args.version) || (args.version as number) < 1) throw new ToolExecutionError("予定のバージョンを正しく指定してください。");
  await deleteCalendarEvent({ calendarId, memberId }, eventId, args.version as number);
  return { ok: true };
}

export async function GET(request: Request) {
  try { await rateLimit(request, "read"); }
  catch (error) {
    if (error instanceof HttpError) return response({ error: error.message }, error.status, error.status === 429 ? { "Retry-After": "60" } : undefined);
    return response({ error: "サーバーでエラーが発生しました。" }, 500);
  }
  if (!originAllowed(request)) return response({ error: "この操作は許可されていません。" }, 403);
  return response({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
}

export async function POST(request: Request, { params }: Context) {
  let parsed: unknown;
  let raw = "";
  let bodyTooLarge = false;
  try { raw = await readBody(request); } catch (error) { if (error instanceof HttpError && error.status === 413) bodyTooLarge = true; else return response({ error: "サーバーでエラーが発生しました。" }, 500); }
  if (!bodyTooLarge) {
    try { parsed = JSON.parse(raw); } catch { /* JSON-RPC parse error is returned after one rate-limit operation. */ }
  }
  try {
    await rateLimit(request, classify(parsed));
  } catch (error) {
    if (error instanceof HttpError) return response({ error: error.message }, error.status, error.status === 429 ? { "Retry-After": "60" } : undefined);
    return response({ error: "サーバーでエラーが発生しました。" }, 500);
  }
  if (bodyTooLarge) return response({ error: "送信内容が大きすぎます。" }, 413);
  if (!originAllowed(request)) return response({ error: "この操作は許可されていません。" }, 403);
  let calendarId: string;
  try { calendarId = (await params).calendarId; requireCalendarId(calendarId); } catch { return response({ error: "カレンダーが見つかりません。" }, 404); }
  const auth = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(auth)?.[1];
  if (!bearer) return response({ error: "参加者のセッションが無効です。" }, 401);
  let member;
  try { member = await findMemberBySecret(calendarId, bearer); } catch { return response({ error: "サーバーでエラーが発生しました。" }, 500); }
  if (!member) return response({ error: "参加者のセッションが無効です。" }, 401);

  if (request.headers.get("content-type")?.toLowerCase().startsWith("application/json") !== true) return rpcError(null, -32600, "Invalid Request");
  if (parsed === undefined) return rpcError(null, -32700, "Parse error");
  if (Array.isArray(parsed)) return rpcError(null, -32600, "Invalid Request");
  if (!parsed || typeof parsed !== "object") return rpcError(null, -32600, "Invalid Request");
  const rpc = parsed as RpcRequest;
  const hasId = Object.prototype.hasOwnProperty.call(rpc, "id");
  const id = rpc.id;
  const method = methodOf(parsed);
  if (rpc.jsonrpc !== "2.0" || typeof method !== "string" || (hasId && !(typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) || id === null))) return rpcError(id, -32600, "Invalid Request");
  if (hasId && id === null) return rpcError(id, -32600, "Invalid Request");
  const versionHeader = request.headers.get("mcp-protocol-version") ?? "2025-03-26";
  if (method !== "initialize" && !SUPPORTED_VERSIONS.includes(versionHeader)) return response({ error: "Unsupported MCP-Protocol-Version" }, 400);
  if (!hasId) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });

  if (method === "initialize") {
    let initParams: Record<string, unknown>;
    try { initParams = paramsObject(rpc.params); } catch { return rpcError(id, -32602, "Invalid params"); }
    const requested = initParams.protocolVersion;
    const clientInfo = initParams.clientInfo;
    if (typeof requested !== "string" || !initParams.capabilities || typeof initParams.capabilities !== "object" || Array.isArray(initParams.capabilities) || !clientInfo || typeof clientInfo !== "object" || Array.isArray(clientInfo) || typeof (clientInfo as Record<string, unknown>).name !== "string" || typeof (clientInfo as Record<string, unknown>).version !== "string") return rpcError(id, -32602, "Invalid params");
    const protocolVersion = typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : "2025-11-25";
    return response({ jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "uchiwa-calendar", version: "1.0.0" } } });
  }
  if (method === "tools/list") return response({ jsonrpc: "2.0", id, result: { tools } });
  if (method === "tools/call") {
    let callParams: Record<string, unknown>;
    try { callParams = paramsObject(rpc.params); } catch { return rpcError(id, -32602, "Invalid params"); }
    if (Object.keys(callParams).some((key) => key !== "name" && key !== "arguments") || typeof callParams.name !== "string") return rpcError(id, -32602, "Invalid params");
    try { return toolResult(id, await callTool(callParams.name, callParams.arguments, calendarId, member.id)); }
    catch (error) {
      if (error instanceof RpcParamsError) return rpcError(id, -32602, "Invalid params");
      if (error instanceof HttpError || error instanceof ToolExecutionError) return toolFailure(id, error.message);
      return toolFailure(id, "予定の処理に失敗しました。");
    }
  }
  return rpcError(id, -32601, "Method not found");
}
