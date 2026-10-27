import { POST as createCalendar } from "../app/api/calendars/route";
import { GET as getCalendar } from "../app/api/calendars/[calendarId]/route";
import { GET as getCalendarFeed } from "../app/api/calendars/[calendarId]/feed/route";
import { PATCH as updateMember, POST as joinCalendar } from "../app/api/calendars/[calendarId]/members/route";
import { POST as createSession, PATCH as rotateSession } from "../app/api/calendars/[calendarId]/session/route";
import { POST as createEvent } from "../app/api/calendars/[calendarId]/events/route";
import { GET as getMcp, POST as postMcp } from "../app/api/calendars/[calendarId]/mcp/route";
import {
  DELETE as deleteEvent,
  PATCH as updateEvent,
} from "../app/api/calendars/[calendarId]/events/[eventId]/route";

function route(method: string, pathname: string) {
  if (pathname === "/api/calendars" && method === "POST") return { handler: createCalendar, params: {} };
  const calendarMatch = pathname.match(/^\/api\/calendars\/([^/]+)$/);
  if (calendarMatch && method === "GET") return { handler: getCalendar, params: { calendarId: decodeURIComponent(calendarMatch[1]) } };
  const feedMatch = pathname.match(/^\/api\/calendars\/([^/]+)\/feed$/);
  if (feedMatch && method === "GET") return { handler: getCalendarFeed, params: { calendarId: decodeURIComponent(feedMatch[1]) } };
  const membersMatch = pathname.match(/^\/api\/calendars\/([^/]+)\/members$/);
  if (membersMatch && method === "POST") return { handler: joinCalendar, params: { calendarId: decodeURIComponent(membersMatch[1]) } };
  if (membersMatch && method === "PATCH") return { handler: updateMember, params: { calendarId: decodeURIComponent(membersMatch[1]) } };
  const sessionMatch = pathname.match(/^\/api\/calendars\/([^/]+)\/session$/);
  if (sessionMatch && method === "POST") return { handler: createSession, params: { calendarId: decodeURIComponent(sessionMatch[1]) } };
  if (sessionMatch && method === "PATCH") return { handler: rotateSession, params: { calendarId: decodeURIComponent(sessionMatch[1]) } };
  const eventsMatch = pathname.match(/^\/api\/calendars\/([^/]+)\/events$/);
  if (eventsMatch && method === "POST") return { handler: createEvent, params: { calendarId: decodeURIComponent(eventsMatch[1]) } };
  const mcpMatch = pathname.match(/^\/api\/calendars\/([^/]+)\/mcp$/);
  if (mcpMatch && (method === "POST" || method === "GET")) return { handler: method === "POST" ? postMcp : getMcp, params: { calendarId: decodeURIComponent(mcpMatch[1]) } };
  const eventMatch = pathname.match(/^\/api\/calendars\/([^/]+)\/events\/([^/]+)$/);
  if (eventMatch && (method === "PATCH" || method === "DELETE")) {
    return {
      handler: method === "PATCH" ? updateEvent : deleteEvent,
      params: { calendarId: decodeURIComponent(eventMatch[1]), eventId: decodeURIComponent(eventMatch[2]) },
    };
  }
  return null;
}

export default {
  async fetch(request: Request) {
    const matched = route(request.method, new URL(request.url).pathname);
    if (!matched) return Response.json({ error: "Not found" }, { status: 404 });
    return matched.handler(request, { params: Promise.resolve({
      calendarId: matched.params.calendarId ?? "",
      eventId: matched.params.eventId ?? "",
    }) });
  },
};
