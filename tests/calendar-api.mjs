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

async function request(method, path, { body, cookies, expectedStatus, originHeader = origin, withoutViewKey = false, viewKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const calendarId = path.match(/^\/api\/calendars\/([^/]+)/)?.[1];
  const key = withoutViewKey ? undefined : viewKey || viewKeys.get(decodeURIComponent(calendarId || ''));
  if (key) headers['X-View-Key'] = key;
  if (originHeader !== null) headers.Origin = originHeader;
  if (cookies?.cookies.size) {
    headers.Cookie = [...cookies.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  const prefix = base.pathname === '/' ? '' : base.pathname;
  const response = await fetch(new URL(`${prefix}${path}`, base.origin), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  passed('cleans up all test events');

  console.log(`\n${checks.length} integration checks passed against ${origin}`);
}

export const runPromise = main();
runPromise.catch((error) => {
  console.error(`\nAPI integration checks failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
