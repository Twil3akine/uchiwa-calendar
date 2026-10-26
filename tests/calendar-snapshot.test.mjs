import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { transformSnapshot } from '../scripts/calendar-snapshot.mjs';

const calendarOne = '6dc7d34d-8965-4f4c-9619-f4dff4f388b6';
const calendarTwo = '9b95f6bf-4fcf-4c40-a1cc-ae37fc874f0f';
const memberOne = 'cfe9e7ca-576f-48db-bbfd-72bbd365ea78';
const memberTwo = '591de6f0-80f1-4481-90ef-a86bd5ef6090';
const eventOne = '9f2c8656-7543-45d6-b823-a495855acbb1';
const eventTwo = 'f8a083d2-ed30-4d74-b2ba-f511706bc659';

function fixture() {
  return {
    calendars: [
      { id: calendarOne, name: "Owner's 日本語 calendar", created_at: '2025-01-02 03:04:05' },
      { id: calendarTwo, name: 'Second calendar', created_at: '2025-02-03 04:05:06' },
    ],
    members: [
      { slot: 8, member_id: memberOne, calendar_id: calendarOne, name: "O'Brien 雪", color: '#2563eb', secret_hash: 'a'.repeat(64), created_at: '2025-03-04 05:06:07' },
      { slot: 13, member_id: memberTwo, calendar_id: calendarTwo, name: '二人目', color: '#db2777', secret_hash: 'b'.repeat(64), created_at: '2025-04-05 06:07:08' },
    ],
    calendar_events: [
      { id: eventOne, calendar_id: calendarOne, member_id: memberOne, title: "O'Brien's trip 🧪", start_date: '2026-07-08', end_date: '2026-07-10', version: 4, created_at: '2025-05-06 07:08:09', updated_at: '2025-06-07 08:09:10' },
      { id: eventTwo, calendar_id: calendarTwo, member_id: memberTwo, title: '出張', start_date: '2026-08-01', end_date: '2026-08-01', version: 1, created_at: '2025-07-08 09:10:11', updated_at: '2025-07-08 09:10:11' },
    ],
  };
}

function splitSql(sql) {
  const statements = [];
  let start = 0;
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index + 1] === quote) {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === ';') {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const last = sql.slice(start).trim();
  if (last) statements.push(last);
  assert.equal(quote, null, 'generated SQL should have balanced quotes');
  return statements;
}

test('transforms a valid snapshot deterministically and reports only counts and hashes', () => {
  const snapshot = fixture();
  const first = transformSnapshot(snapshot);
  const reordered = {
    calendars: [...snapshot.calendars].reverse(),
    members: [...snapshot.members].reverse(),
    calendar_events: [...snapshot.calendar_events].reverse(),
  };
  const second = transformSnapshot(reordered);
  assert.equal(first.sql, second.sql);
  assert.deepEqual(first.metadata, second.metadata);
  assert.deepEqual(first.metadata.counts, { calendars: 2, members: 2, calendar_events: 2 });
  assert.match(first.metadata.migrationSha256, /^[a-f0-9]{64}$/);
  assert.match(first.metadata.sourceSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(first.sql, /Owner''s 日本語 calendar/);
  assert.match(first.sql, /O''Brien''s trip 🧪/);
  assert.match(first.sql, /INSERT INTO members \(slot, member_id, calendar_id, name, color, secret_hash, created_at\) VALUES \(8,/);
  assert.match(first.sql, /VALUES \(13,/);
  assert.ok(!JSON.stringify(first.metadata).includes('O’Brien'));
  assert.ok(!JSON.stringify(first.metadata).includes('a'.repeat(64)));
});

test('rejects missing or unexpected columns and malformed or truncated values', () => {
  const missingColumn = fixture();
  delete missingColumn.members[0].secret_hash;
  assert.throws(() => transformSnapshot(missingColumn), /missing or unexpected columns/);

  const unexpectedColumn = fixture();
  unexpectedColumn.calendars[0].other = 'value';
  assert.throws(() => transformSnapshot(unexpectedColumn), /missing or unexpected columns/);

  const shortHash = fixture();
  shortHash.members[0].secret_hash = 'a'.repeat(63);
  assert.throws(() => transformSnapshot(shortHash), /full SHA-256/);

  const emptyName = fixture();
  emptyName.members[0].name = '';
  assert.throws(() => transformSnapshot(emptyName), /non-empty string/);

  const invalidTimestamp = fixture();
  invalidTimestamp.calendars[0].created_at = '2025-01-02 03:04';
  assert.throws(() => transformSnapshot(invalidTimestamp), /complete SQLite timestamp/);
});

test('rejects invalid slots, event versions, dates, and ranges', () => {
  const zeroSlot = fixture();
  zeroSlot.members[0].slot = 0;
  assert.throws(() => transformSnapshot(zeroSlot), /positive safe integer/);

  const invalidVersion = fixture();
  invalidVersion.calendar_events[0].version = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => transformSnapshot(invalidVersion), /positive safe integer/);

  const impossibleDate = fixture();
  impossibleDate.calendar_events[0].start_date = '2026-02-30';
  assert.throws(() => transformSnapshot(impossibleDate), /not a real calendar date/);

  const reversed = fixture();
  reversed.calendar_events[0].start_date = '2026-07-11';
  assert.throws(() => transformSnapshot(reversed), /ends before it starts/);
});

test('rejects broken and cross-calendar references and duplicate identities', () => {
  const missingCalendar = fixture();
  missingCalendar.members[0].calendar_id = '11111111-1111-4111-8111-111111111111';
  assert.throws(() => transformSnapshot(missingCalendar), /references missing calendar/);

  const mismatchedMemberCalendar = fixture();
  mismatchedMemberCalendar.calendar_events[0].calendar_id = calendarTwo;
  assert.throws(() => transformSnapshot(mismatchedMemberCalendar), /member belongs to a different calendar/);

  const duplicateSlot = fixture();
  duplicateSlot.members[1].slot = duplicateSlot.members[0].slot;
  assert.throws(() => transformSnapshot(duplicateSlot), /duplicate member slot/);

  const duplicateEvent = fixture();
  duplicateEvent.calendar_events[1].id = eventOne;
  assert.throws(() => transformSnapshot(duplicateEvent), /duplicate event ID/);
});

test('CLI writes a migration and metadata sidecar without printing snapshot values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'calendar-snapshot-'));
  try {
    const inputPath = path.join(directory, 'input.json');
    const outputPath = path.join(directory, 'snapshot.sql');
    const metadataPath = path.join(directory, 'snapshot.metadata.json');
    const privateMarker = 'Private migration test title';
    const snapshot = fixture();
    snapshot.calendar_events[0].title = privateMarker;
    await writeFile(inputPath, JSON.stringify(snapshot));
    const scriptPath = fileURLToPath(new URL('../scripts/calendar-snapshot.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [scriptPath, '--input', inputPath, '--output', outputPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(privateMarker));
    const sql = await readFile(outputPath, 'utf8');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.match(sql, /Private migration test title/);
    assert.equal(metadata.migrationSha256, (await import('node:crypto')).createHash('sha256').update(sql).digest('hex'));
    assert.deepEqual(metadata.counts, { calendars: 2, members: 2, calendar_events: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generated migration round-trips exact rows into ephemeral Miniflare D1 and retains slot sequence', async () => {
  const wranglerRequire = createRequire(import.meta.resolve('wrangler/package.json'));
  const { Miniflare } = wranglerRequire('miniflare');
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response("ok"); } };',
    compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
  });
  try {
    const snapshot = fixture();
    const { sql } = transformSnapshot(snapshot);
    const db = await miniflare.getD1Database('DB');
    const statements = splitSql(sql);
    await db.batch(statements.map((statement) => db.prepare(statement)));

    const calendars = await db.prepare('SELECT id, name, created_at FROM calendars ORDER BY id').all();
    assert.deepEqual(calendars.results, [...snapshot.calendars].sort((a, b) => a.id.localeCompare(b.id)));
    const members = await db.prepare('SELECT slot, member_id, calendar_id, name, color, secret_hash, created_at FROM members ORDER BY slot').all();
    assert.deepEqual(members.results, [...snapshot.members].sort((a, b) => a.slot - b.slot));
    const events = await db.prepare('SELECT id, calendar_id, member_id, title, start_date, end_date, version, created_at, updated_at FROM calendar_events ORDER BY id').all();
    assert.deepEqual(events.results, [...snapshot.calendar_events].sort((a, b) => a.id.localeCompare(b.id)));

    const nextSlot = await db.prepare("INSERT INTO members (member_id, calendar_id, name, color, secret_hash) VALUES (?, ?, ?, ?, ?) RETURNING slot")
      .bind('be1e3855-3f11-4429-8e87-ec91b17821ae', calendarOne, 'Sequence check', '#059669', 'c'.repeat(64)).first();
    assert.equal(nextSlot.slot, 14);
  } finally {
    await miniflare.dispose();
  }
});
