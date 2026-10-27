#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const suppliedUrl = process.argv[2] || process.env.CALENDAR_TEST_URL;
if (!suppliedUrl) {
  console.error('Usage: node tests/calendar-api.mjs <explicit-base-url> (or set CALENDAR_TEST_URL)');
  process.exit(2);
}

let base;
try {
  base = new URL(suppliedUrl);
  assert.ok(['http:', 'https:'].includes(base.protocol), 'base URL must use HTTP or HTTPS');
} catch (error) {
  console.error(`Invalid base URL: ${error.message}`);
  process.exit(2);
}
base.pathname = base.pathname.replace(/\/$/, '');
const origin = base.origin;

const jar = () => ({ cookies: new Map() });

function absorbCookies(response, targetJar) {
  if (!targetJar) return;
  let setCookies = [];
  if (typeof response.headers.getSetCookie === 'function') {
    setCookies = response.headers.getSetCookie();
  } else {
    const cookie = response.headers.get('set-cookie');
    if (cookie) setCookies = [cookie];
  }
  for (const rawCookie of setCookies) {
    const firstPart = rawCookie.split(';', 1)[0];
    const separator = firstPart.indexOf('=');
    if (separator < 1) continue;
    const name = firstPart.slice(0, separator).trim();
    const value = firstPart.slice(separator + 1).trim();
    if (!value || /max-age=0/i.test(rawCookie)) targetJar.cookies.delete(name);
    else targetJar.cookies.set(name, value);
  }
}

const viewKeys = new Map();

async function request(method, path, { body, rawBody, headers: extraHeaders, cookies, expectedStatus, originHeader = origin, ip = '203.0.113.1', withoutViewKey = false, viewKey } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  const calendarId = path.match(/^\/api\/calendars\/([^/]+)/)?.[1];
  const key = withoutViewKey ? undefined : viewKey || viewKeys.get(decodeURIComponent(calendarId || ''));
  if (key) headers['X-View-Key'] = key;
  Object.assign(headers, extraHeaders || {});
  if (originHeader !== null) headers.Origin = originHeader;
  if (cookies?.cookies.size) {
    headers.Cookie = [...cookies.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  const prefix = base.pathname === '/' ? '' : base.pathname;
  const response = await fetch(new URL(`${prefix}${path}`, base.origin), {
    method,
    headers,
    ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  absorbCookies(response, cookies);
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`${method} ${path} returned non-JSON (${response.status}): ${raw.slice(0, 200)}`);
  }
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${raw}`);
  }
  return { status: response.status, data, raw };
}

async function feed(calendarId, { cookie, originHeader, withoutViewKey = false, viewKey } = {}) {
  const headers = { 'CF-Connecting-IP': '203.0.113.1' };
  if (cookie) headers.Cookie = cookie;
  if (originHeader !== undefined && originHeader !== null) headers.Origin = originHeader;
  const prefix = base.pathname === '/' ? '' : base.pathname;
  const key = withoutViewKey ? undefined : viewKey || viewKeys.get(calendarId);
  const url = new URL(`${prefix}/api/calendars/${encodeURIComponent(calendarId)}/feed`, base.origin);
  if (key) url.searchParams.set('k', key);
  const response = await fetch(url, { headers });
  return { status: response.status, contentType: response.headers.get('content-type'), headers: response.headers, body: await response.text() };
}

const ok = (result, message) => assert.ok(result.status >= 200 && result.status < 300, `${message}: HTTP ${result.status} ${result.raw}`);
const eventId = () => randomUUID();
const checks = [];
const passed = (description) => {
  checks.push(description);
  console.log(`✓ ${description}`);
};

function noSecretMaterial(value, secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!serialized.includes(secret), 'response leaked a submitted member secret');
  assert.doesNotMatch(serialized, /"(?:secret|secretHash|secret_hash|tokenHash|token_hash)"\s*:/i, 'response exposed secret/hash field');
}

async function main() {
  const anonymous = jar();
  const viewKeyA = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const viewKeyB = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const calendarAResponse = await request('POST', '/api/calendars', {
    body: { name: `A-${randomUUID()}`, viewKey: viewKeyA },
  });
  const calendarBResponse = await request('POST', '/api/calendars', {
    body: { name: `B-${randomUUID()}`, viewKey: viewKeyB },
  });
  ok(calendarAResponse, 'create calendar A');
  ok(calendarBResponse, 'create calendar B');
  const calendarA = calendarAResponse.data.calendar;
  const calendarB = calendarBResponse.data.calendar;
  assert.ok(calendarA?.id && calendarB?.id);
  assert.notEqual(calendarA.id, calendarB.id);
  viewKeys.set(calendarA.id, viewKeyA); viewKeys.set(calendarB.id, viewKeyB);
  passed('creates two independent calendars');

  await request('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { expectedStatus: 404, withoutViewKey: true });
  const readA = await request('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { expectedStatus: 200 });
  assert.equal(readA.data.me, null);
  assert.doesNotMatch(JSON.stringify(readA.data), /"(?:secret|secretHash|secret_hash|tokenHash|token_hash)"\s*:/i);
  const anonymousWrite = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: { id: eventId(), title: 'anonymous', startDate: '2026-04-01', endDate: '2026-04-01' },
  });
  assert.ok([401, 403].includes(anonymousWrite.status), `anonymous event write should be denied, got ${anonymousWrite.status}`);
  passed('requires a valid shared key for anonymous calendar reads and denies anonymous writes');

  const missingKeyFeed = await feed(calendarA.id, { withoutViewKey: true });
  assert.equal(missingKeyFeed.status, 404, 'protected feeds reject requests without a view key');
  const oldKeyFeed = await feed(calendarA.id, { viewKey: 'x'.repeat(43) });
  assert.equal(oldKeyFeed.status, 404, 'protected feeds reject stale or incorrect view keys');
  const emptyFeed = await feed(calendarA.id);
  assert.equal(emptyFeed.status, 200);
  assert.match(emptyFeed.contentType, /^text\/calendar;\s*charset=utf-8/i);
  assert.equal(emptyFeed.headers.get('cache-control'), 'no-store');
  assert.equal(emptyFeed.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(emptyFeed.headers.get('x-content-type-options'), 'nosniff');
  assert.match(emptyFeed.body, /BEGIN:VCALENDAR\r\n/);
  assert.doesNotMatch(emptyFeed.body, /BEGIN:VEVENT/);
  const invalidCookieFeed = await feed(calendarA.id, { cookie: 'calendar_session_invalid=not-a-secret', withoutViewKey: true });
  assert.equal(invalidCookieFeed.status, 404, 'cookies do not bypass view-key protection');
  const legacyFeedId = process.env.CALENDAR_TEST_LEGACY_ID;
  assert.ok(legacyFeedId, 'isolated test runner must seed a legacy calendar');
  assert.equal((await feed(legacyFeedId)).status, 200, 'legacy calendars without a view key retain anonymous feed compatibility');
  passed('protects keyed iCalendar feeds and preserves legacy feeds with no view key');

  const secretA = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const secretB = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const secretC = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  assert.match(secretA, /^[A-Za-z0-9_-]{43}$/);
  assert.match(secretB, /^[A-Za-z0-9_-]{43}$/);
  const jarA = jar();
  const jarB = jar();
  const jarC = jar();
  const joinA = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/members`, {
    body: { name: 'Same name', secret: secretA }, cookies: jarA,
  });
  const joinB = await request('POST', `/api/calendars/${encodeURIComponent(calendarB.id)}/members`, {
    body: { name: 'Same name', secret: secretB }, cookies: jarB,
  });
  ok(joinA, 'join calendar A');
  ok(joinB, 'join calendar B');
  const memberA = joinA.data.member;
  const memberB = joinB.data.member;
  assert.ok(memberA?.id && memberA?.name && memberA?.color);
  assert.ok(memberB?.id && memberB?.name && memberB?.color);
  const memberCookie = [...jarA.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  assert.equal((await feed(calendarA.id, { cookie: memberCookie, withoutViewKey: true })).status, 404, 'member cookies do not replace the feed URL key');
  assert.notEqual(memberA.id, memberB.id, 'same names must not identify the same person');
  noSecretMaterial(joinA.data, [secretA]);
  noSecretMaterial(joinB.data, [secretB]);
  assert.ok(jarA.cookies.size && jarB.cookies.size, 'member creation should set auth cookies');
  const retryJarA = jar();
  const joinRetry = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/members`, {
    body: { name: 'Same name', secret: secretA }, cookies: retryJarA,
  });
  ok(joinRetry, 'idempotent member join retry');
  assert.equal(joinRetry.data.member.id, memberA.id);
  assert.equal(joinRetry.data.member.color, memberA.color);
  passed('creates distinct same-name members, idempotently retries joins, and sets per-calendar cookies');

  const bOnlyEvent = { id: eventId(), title: 'B calendar only', startDate: '2026-04-20', endDate: '2026-04-20' };
  const bEvent = await request('POST', `/api/calendars/${encodeURIComponent(calendarB.id)}/events`, { body: bOnlyEvent, cookies: jarB });
  ok(bEvent, 'create event in calendar B');

  const restoredJarA = jar();
  const restored = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/session`, {
    body: { secret: secretA }, cookies: restoredJarA, expectedStatus: 200,
  });
  assert.equal(restored.data.member.id, memberA.id);
  assert.equal(restored.data.member.color, memberA.color);
  noSecretMaterial(restored.data, [secretA]);
  const restoredRead = await request('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA, expectedStatus: 200 });
  assert.equal(restoredRead.data.me.id, memberA.id);
  noSecretMaterial(restoredRead.data, [secretA]);
  passed('restores the same member identity, color, and rights from its secret');

  const mcpPath = `/api/calendars/${encodeURIComponent(calendarA.id)}/mcp`;
  const mcp = (body, options = {}) => request('POST', mcpPath, {
    body, headers: { Authorization: `Bearer ${secretA}`, ...(options.headers || {}) },
    ...(options.originHeader === undefined ? {} : { originHeader: options.originHeader }),
  });
  const mcpInit = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'isolated-test', version: '1' } } }, { headers: { 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(mcpInit.status, 200);
  assert.equal(mcpInit.data.result.protocolVersion, '2025-11-25');
  assert.ok(mcpInit.data.result.capabilities.tools);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 14, method: 'tools/list' }, { originHeader: null })).status, 200);
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const mcpTools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(mcpTools.data.result.tools.map((tool) => tool.name), ['list_events', 'add_event', 'delete_event']);
  assert.equal((await request('GET', mcpPath)).status, 405);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { headers: { 'MCP-Protocol-Version': 'unsupported' } })).status, 400);
  assert.equal((await mcp(null, { headers: {}, originHeader: 'https://wrong-origin.invalid' })).status, 403);
  const malformedRpc = await request('POST', mcpPath, { rawBody: '{', headers: { Authorization: `Bearer ${secretA}` } });
  assert.equal(malformedRpc.data.error.code, -32700);
  const batchRpc = await mcp([{ jsonrpc: '2.0', id: 4, method: 'tools/list' }]);
  assert.equal(batchRpc.data.error.code, -32600);
  const unknownRpc = await mcp({ jsonrpc: '2.0', id: 5, method: 'unknown/method' });
  assert.equal(unknownRpc.data.error.code, -32601);
  const cookieOnlyMcp = await request('POST', mcpPath, { body: { jsonrpc: '2.0', id: 6, method: 'tools/list' }, cookies: restoredJarA });
  assert.equal(cookieOnlyMcp.status, 401);
  const wrongBearerMcp = await request('POST', mcpPath, { body: { jsonrpc: '2.0', id: 7, method: 'tools/list' }, headers: { Authorization: `Bearer ${secretB}` } });
  assert.equal(wrongBearerMcp.status, 401);
  noSecretMaterial(mcpInit.data, [secretA]);
  noSecretMaterial(mcpTools.data, [secretA]);
  passed('enforces MCP initialization, notifications, tools, protocol errors, origin and Bearer-only authentication');

  const initialEvent = {
    id: eventId(), title: 'multi-day literal', startDate: '2026-04-10', endDate: '2026-04-12',
  };
  const created = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: initialEvent, cookies: restoredJarA,
  });
  ok(created, 'create multi-day event');
  const event = created.data.event;
  assert.equal(event.id, initialEvent.id);
  assert.equal(event.memberId, memberA.id);
  assert.equal(event.startDate, initialEvent.startDate);
  assert.equal(event.endDate, initialEvent.endDate);
  assert.equal(event.version, 1);
  assert.equal(event.title, initialEvent.title);
  let feedA = await feed(calendarA.id);
  assert.equal(feedA.status, 200);
  assert.match(feedA.body, new RegExp(`UID:${event.id}@uchiwa-calendar`));
  assert.match(feedA.body, /SUMMARY:multi-day literal/);
  assert.match(feedA.body, /DESCRIPTION:Same name/);
  assert.match(feedA.body, /DTSTART;VALUE=DATE:20260410/);
  assert.match(feedA.body, /DTEND;VALUE=DATE:20260413/);
  assert.doesNotMatch(feedA.body, /B calendar only/);
  assert.doesNotMatch(feedA.body, new RegExp(secretA));
  assert.doesNotMatch(feedA.body, new RegExp(secretB));
  assert.doesNotMatch(feedA.body, /secret_hash|secretHash|tokenHash/i);
  const rotatedViewKey = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const shareRotation = await request('PATCH', `/api/calendars/${encodeURIComponent(calendarA.id)}/share`, {
    body: { confirm: true, key: rotatedViewKey, expectedKey: viewKeyA }, cookies: restoredJarA, expectedStatus: 200,
  });
  assert.equal(shareRotation.data.ok, true);
  assert.equal((await feed(calendarA.id, { viewKey: viewKeyA })).status, 404, 'share-key rotation invalidates old feed URLs');
  assert.equal((await feed(calendarA.id, { withoutViewKey: true })).status, 404, 'rotated feed still rejects missing keys');
  viewKeys.set(calendarA.id, rotatedViewKey);
  const rotatedFeed = await feed(calendarA.id);
  assert.equal(rotatedFeed.status, 200);
  assert.match(rotatedFeed.body, new RegExp(`UID:${event.id}@uchiwa-calendar`));
  assert.equal((await mcp({ jsonrpc: '2.0', id: 15, method: 'tools/list' })).status, 200, 'MCP Bearer authentication remains independent of shared-key rotation');
  passed('exports protected feed details and revokes the old subscription URL after share-key rotation');

  const mcpList = await mcp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_events', arguments: { from: '2026-04-11', to: '2026-04-11' } } });
  const mcpListedEvents = mcpList.data.result.structuredContent.events;
  const mcpListedEvent = mcpListedEvents.find((item) => item.id === event.id);
  assert.equal(mcpListedEvent.version, 1);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_events', arguments: { from: '2026-04-13', to: '2026-04-14' } } })).data.result.structuredContent.events.some((item) => item.id === event.id), false);
  const mcpEventBody = { eventId: eventId(), title: 'MCP retry', startDate: '2026-04-20', endDate: '2026-04-21' };
  const mcpAddRequest = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'add_event', arguments: mcpEventBody } };
  const mcpAddPair = await Promise.all([mcp(mcpAddRequest), mcp(mcpAddRequest)]);
  assert.ok(mcpAddPair.every((item) => !item.data.result.isError));
  assert.equal(mcpAddPair[0].data.result.structuredContent.event.id, mcpEventBody.eventId);
  const mcpAdded = mcpAddPair[0].data.result.structuredContent.event;
  const mcpDeleteStale = await mcp({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'delete_event', arguments: { eventId: mcpAdded.id, version: 2 } } });
  assert.equal(mcpDeleteStale.data.result.isError, true);
  const mcpDelete = await mcp({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'delete_event', arguments: { eventId: mcpAdded.id, version: 1 } } });
  assert.deepEqual(mcpDelete.data.result.structuredContent, { ok: true });
  passed('lists overlapping MCP events with versions, idempotently registers concurrent retries, and rejects stale deletion versions');

  const rotatedSecret = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const rotated = await request('PATCH', `/api/calendars/${encodeURIComponent(calendarA.id)}/session`, {
    body: { confirm: true, secret: rotatedSecret }, cookies: restoredJarA, expectedStatus: 200,
  });
  assert.equal(rotated.data.member.id, memberA.id);
  assert.equal(rotated.data.secret, rotatedSecret, 'the rotation response returns the new secret to the authenticated member by design');
  const revokedBearer = await request('POST', mcpPath, { body: { jsonrpc: '2.0', id: 13, method: 'tools/list' }, headers: { Authorization: `Bearer ${secretA}` } });
  assert.equal(revokedBearer.status, 401);
  passed('revokes the old MCP Bearer when the participant secret is rotated');

  const joinC = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/members`, {
    body: { name: 'Same name', secret: secretC }, cookies: jarC,
  });
  ok(joinC, 'join calendar A as member C');
  const memberC = joinC.data.member;
  assert.notEqual(memberC.id, memberA.id, 'same-calendar same-name members must have different IDs');
  assert.notEqual(memberC.color, memberA.color, 'same-calendar same-name members must have different colors');
  const cPatchA = await request('PATCH', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${event.id}`, {
    body: { title: 'other member edit', startDate: event.startDate, endDate: event.endDate, version: event.version }, cookies: jarC,
  });
  assert.equal(cPatchA.status, 403, `another member in the same calendar must not patch the event, got ${cPatchA.status}`);
  const cDeleteA = await request('DELETE', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${event.id}`, {
    body: { version: event.version }, cookies: jarC,
  });
  assert.equal(cDeleteA.status, 403, `another member in the same calendar must not delete the event, got ${cDeleteA.status}`);
  const unchangedAfterOtherMember = (await request('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA })).data.events.find((x) => x.id === event.id);
  assert.equal(unchangedAfterOtherMember.title, initialEvent.title);
  assert.equal(unchangedAfterOtherMember.version, event.version);
  passed('keeps same-calendar member events private by member ID');

  const palette = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4f46e5'];
  const membersPath = `/api/calendars/${encodeURIComponent(calendarA.id)}/members`;
  const colorRequest = (method, path, options = {}) => request(method, path, { ...options, ip: '203.0.113.4' });
  let selectedColor = memberA.color;
  for (const color of palette) {
    const changed = await colorRequest('PATCH', membersPath, { body: { color }, cookies: restoredJarA, expectedStatus: 200 });
    assert.deepEqual(changed.data.member, { id: memberA.id, name: memberA.name, color });
    const colorRead = await colorRequest('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA, expectedStatus: 200 });
    assert.equal(colorRead.data.me.color, color);
    assert.equal(colorRead.data.members.find((member) => member.id === memberA.id).color, color);
    selectedColor = color;
  }
  const persistedColor = await colorRequest('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA, expectedStatus: 200 });
  assert.equal(persistedColor.data.me.color, selectedColor);
  assert.equal(persistedColor.data.members.find((member) => member.id === memberA.id).color, selectedColor);
  assert.equal((await colorRequest('PATCH', membersPath, { body: { color: selectedColor }, cookies: restoredJarA })).status, 200, 'resending the current color should succeed');

  const invalidColorBodies = [
    undefined, null, { color: null }, { color: 7 }, { color: '#ffffff' }, { color: palette[0], memberId: memberC.id },
  ];
  for (const body of invalidColorBodies) {
    assert.equal((await colorRequest('PATCH', membersPath, { body, cookies: restoredJarA })).status, 400);
  }
  const afterInvalidColors = await colorRequest('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA, expectedStatus: 200 });
  assert.equal(afterInvalidColors.data.me.color, selectedColor, 'rejected payloads must not change the member color');
  assert.equal(afterInvalidColors.data.members.find((member) => member.id === memberA.id).color, selectedColor);
  assert.equal((await colorRequest('PATCH', membersPath, { body: { color: palette[0] } })).status, 401, 'cookie-less color changes must be rejected');
  const invalidCookieJar = jar(); invalidCookieJar.cookies.set(`calendar_session_${calendarA.id}`, 'invalid-session');
  assert.equal((await colorRequest('PATCH', membersPath, { body: { color: palette[0] }, cookies: invalidCookieJar })).status, 401);
  assert.equal((await colorRequest('PATCH', membersPath, { body: { color: palette[0] }, cookies: jarB })).status, 401, 'another calendar session must not authenticate here');
  const crossCalendarSecretJar = jar(); crossCalendarSecretJar.cookies.set(`calendar_session_${calendarA.id}`, secretB);
  assert.equal((await colorRequest('PATCH', membersPath, { body: { color: palette[0] }, cookies: crossCalendarSecretJar })).status, 401, 'another calendar secret under this calendar cookie name must not authenticate');
  assert.equal((await colorRequest('PATCH', membersPath, { body: { color: palette[0] }, cookies: restoredJarA, originHeader: 'https://wrong-origin.invalid' })).status, 403);
  assert.equal((await colorRequest('PATCH', membersPath, { body: { color: palette[0] }, cookies: restoredJarA, originHeader: null })).status, 403);

  const memberDSecret = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const memberDJar = jar();
  const memberDJoin = await colorRequest('POST', membersPath, { body: { name: 'Member D', secret: memberDSecret }, cookies: memberDJar });
  ok(memberDJoin, 'join as member D');
  const memberD = memberDJoin.data.member;
  assert.equal((await colorRequest('PATCH', membersPath, { body: { color: palette[1] }, cookies: memberDJar })).status, 200);
  const afterMemberD = await colorRequest('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA, expectedStatus: 200 });
  assert.equal(afterMemberD.data.members.find((member) => member.id === memberA.id).color, selectedColor, 'member D must not change member A color');
  assert.equal(afterMemberD.data.members.find((member) => member.id === memberD.id).color, palette[1]);
  const memberESecret = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const memberE = await colorRequest('POST', membersPath, { body: { name: 'Member E', secret: memberESecret }, cookies: jar() });
  ok(memberE, 'join as member E');
  assert.equal(memberE.data.member.color, palette[3], 'manual color changes must not affect count based automatic assignment (E is the 4th member of calendar A: A, C, D, E)');

  const colorRestoreJar = jar();
  assert.equal((await colorRequest('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/session`, { body: { secret: rotatedSecret }, cookies: colorRestoreJar })).status, 200);
  const colorRestored = await colorRequest('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: colorRestoreJar, expectedStatus: 200 });
  assert.equal(colorRestored.data.me.color, selectedColor);
  passed('changes only the authenticated member color, persists all palette values, and rejects invalid or cross-session changes');

  const duplicate = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: initialEvent, cookies: restoredJarA,
  });
  ok(duplicate, 'idempotent duplicate create');
  assert.equal(duplicate.data.event.id, event.id);
  assert.equal((await request('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA })).data.events.filter((x) => x.id === event.id).length, 1);
  const conflictingCreate = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: { ...initialEvent, title: 'conflicting payload' }, cookies: restoredJarA,
  });
  assert.ok([400, 409].includes(conflictingCreate.status), `conflicting event ID should fail, got ${conflictingCreate.status}`);
  passed('creates a multi-day event, treats exact retries idempotently, and rejects ID conflicts');

  const invalidDate = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: { id: eventId(), title: 'bad date', startDate: '2026-02-30', endDate: '2026-03-01' }, cookies: restoredJarA,
  });
  assert.equal(invalidDate.status, 400);
  const reversed = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: { id: eventId(), title: 'reversed', startDate: '2026-04-12', endDate: '2026-04-10' }, cookies: restoredJarA,
  });
  assert.equal(reversed.status, 400);
  const unknownAvailability = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: { id: eventId(), title: 'unknown fields', startDate: '2026-04-01', endDate: '2026-04-01', availability: 'free', status: 'confirmed' }, cookies: restoredJarA,
  });
  assert.equal(unknownAvailability.status, 400);
  const originBody = { id: eventId(), title: 'origin denied', startDate: '2026-04-01', endDate: '2026-04-01' };
  const wrongOrigin = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: originBody, cookies: restoredJarA, originHeader: 'https://not-the-request-origin.invalid',
  });
  assert.ok([400, 403].includes(wrongOrigin.status), `wrong Origin should be denied, got ${wrongOrigin.status}`);
  const missingOrigin = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: { ...originBody, id: eventId() }, cookies: restoredJarA, originHeader: null,
  });
  assert.ok([400, 403].includes(missingOrigin.status), `missing Origin should be denied, got ${missingOrigin.status}`);
  passed('rejects impossible dates, reversed ranges, unknown fields, and missing or wrong Origin');

  const bSessionOnA = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/session`, {
    body: { secret: secretB },
  });
  assert.ok([401, 403].includes(bSessionOnA.status), `cross-calendar secret should fail, got ${bSessionOnA.status}`);
  const bPatchA = await request('PATCH', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${event.id}`, {
    body: { title: 'stolen edit', startDate: event.startDate, endDate: event.endDate, version: event.version }, cookies: jarB,
  });
  assert.ok([401, 403].includes(bPatchA.status), `other-calendar member patch should fail, got ${bPatchA.status}`);
  const bDeleteA = await request('DELETE', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${event.id}`, {
    body: { version: event.version }, cookies: jarB,
  });
  assert.ok([401, 403].includes(bDeleteA.status), `other-calendar member delete should fail, got ${bDeleteA.status}`);
  const eventIdInB = await request('PATCH', `/api/calendars/${encodeURIComponent(calendarB.id)}/events/${event.id}`, {
    body: { title: 'cross-calendar', startDate: event.startDate, endDate: event.endDate, version: event.version }, cookies: jarB,
  });
  assert.ok([404, 409].includes(eventIdInB.status), `calendar B must not resolve A event ID, got ${eventIdInB.status}`);
  passed('rejects cross-calendar secrets, writes, and event IDs');

  const updated = await request('PATCH', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${event.id}`, {
    body: { title: 'updated literal', startDate: '2026-04-11', endDate: '2026-04-13', version: event.version },
    cookies: restoredJarA, expectedStatus: 200,
  });
  const current = updated.data.event;
  assert.equal(current.version, event.version + 1);
  feedA = await feed(calendarA.id, { cookie: `calendar_session_${calendarA.id}=invalid` });
  assert.match(feedA.body, new RegExp(`UID:${event.id}@uchiwa-calendar`));
  assert.match(feedA.body, /SUMMARY:updated literal/);
  assert.match(feedA.body, /DTSTART;VALUE=DATE:20260411/);
  assert.match(feedA.body, /DTEND;VALUE=DATE:20260414/);
  passed('keeps event UID stable while updating feed contents after edits');
  const staleUpdate = await request('PATCH', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${event.id}`, {
    body: { title: 'stale overwrite', startDate: event.startDate, endDate: event.endDate, version: event.version }, cookies: restoredJarA,
  });
  assert.equal(staleUpdate.status, 409);
  const staleDelete = await request('DELETE', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${event.id}`, {
    body: { version: event.version }, cookies: restoredJarA,
  });
  assert.equal(staleDelete.status, 409);
  passed('updates event versions and rejects stale updates and deletes');

  const concurrentId = eventId();
  const concurrentCreateBody = { id: concurrentId, title: 'concurrency', startDate: '2026-05-01', endDate: '2026-05-01' };
  const concurrentCreated = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: concurrentCreateBody, cookies: restoredJarA,
  });
  ok(concurrentCreated, 'create concurrency event');
  const concurrentEvent = concurrentCreated.data.event;
  const race = await Promise.all(['first writer', 'second writer'].map((title) => request('PATCH', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${concurrentId}`, {
    body: { title, startDate: concurrentEvent.startDate, endDate: concurrentEvent.endDate, version: concurrentEvent.version }, cookies: restoredJarA,
  })));
  assert.equal(race.filter((r) => r.status === 200).length, 1, 'exactly one concurrent update should win');
  assert.equal(race.filter((r) => r.status === 409).length, 1, 'the other concurrent update should be stale');
  passed('allows exactly one winner for concurrent same-version updates');

  const concurrentCreateId = eventId();
  const parallelCreateBody = { id: concurrentCreateId, title: 'concurrent identical create', startDate: '2026-05-10', endDate: '2026-05-11' };
  const createRace = await Promise.all([1, 2].map(() => request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: parallelCreateBody, cookies: restoredJarA,
  })));
  for (const result of createRace) ok(result, 'concurrent idempotent event create');
  assert.equal(createRace[0].data.event.id, concurrentCreateId);
  assert.equal(createRace[1].data.event.id, concurrentCreateId);
  const concurrentCreateStored = (await request('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA })).data.events.filter((x) => x.id === concurrentCreateId);
  assert.equal(concurrentCreateStored.length, 1, 'concurrent same-ID creates should store one event');
  passed('concurrent identical event creates both succeed and store one event');

  const malicious = '<script>alert("literal")</script> & "quoted"';
  const literalEvent = { id: eventId(), title: malicious, startDate: '2026-06-01', endDate: '2026-06-01' };
  const literalCreated = await request('POST', `/api/calendars/${encodeURIComponent(calendarA.id)}/events`, {
    body: literalEvent, cookies: restoredJarA,
  });
  ok(literalCreated, 'create literal-title event');
  assert.equal(literalCreated.data.event.title, malicious);
  passed('stores malicious-looking titles as literal data');

  for (const tracked of [current, race.find((r) => r.status === 200).data.event, concurrentCreateStored[0], literalCreated.data.event]) {
    const deleted = await request('DELETE', `/api/calendars/${encodeURIComponent(calendarA.id)}/events/${tracked.id}`, {
      body: { version: tracked.version }, cookies: restoredJarA, expectedStatus: 200,
    });
    assert.equal(deleted.data.ok, true);
  }
  const finalFeed = await feed(calendarA.id);
  for (const tracked of [current, race.find((r) => r.status === 200).data.event, concurrentCreateStored[0], literalCreated.data.event]) {
    assert.doesNotMatch(finalFeed.body, new RegExp(`UID:${tracked.id}@uchiwa-calendar`));
  }
  const missingFeed = await feed('00000000-0000-0000-0000-000000000000');
  assert.equal(missingFeed.status, 404);
  assert.deepEqual(JSON.parse(missingFeed.body), { error: 'カレンダーが見つかりません。' });
  const feedB = await feed(calendarB.id);
  assert.match(feedB.body, /SUMMARY:B calendar only/);
  assert.doesNotMatch(feedB.body, new RegExp(`UID:${event.id}@uchiwa-calendar`));
  passed('cleans up all test events');

  const colorRotationSecret = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
  const colorRotation = await request('PATCH', `/api/calendars/${encodeURIComponent(calendarA.id)}/session`, {
    body: { confirm: true, secret: colorRotationSecret }, cookies: restoredJarA, expectedStatus: 200,
  });
  assert.equal(colorRotation.data.member.color, selectedColor);
  const afterColorRotation = await request('GET', `/api/calendars/${encodeURIComponent(calendarA.id)}`, { cookies: restoredJarA, expectedStatus: 200 });
  assert.equal(afterColorRotation.data.me.color, selectedColor);
  passed('preserves the selected color when the personal link is reissued');

  console.log(`\n${checks.length} integration checks passed against ${origin}`);
}

export const runPromise = main();
runPromise.catch((error) => {
  console.error(`\nAPI integration checks failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
