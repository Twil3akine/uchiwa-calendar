#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const migrationSource = await readFile(new URL('../drizzle/0000_lean_omega_red.sql', import.meta.url), 'utf8');
const schemaStatements = migrationSource
  .split(/-->\s*statement-breakpoint/g)
  .map((statement) => statement.trim())
  .filter(Boolean)
  .map((statement) => statement.includes('CREATE TABLE `calendars`') ? statement.replace('`name` text NOT NULL,', '`name` text NOT NULL,\n\t`view_key_hash` text,') : statement);

const expectedKeys = {
  calendars: ['id', 'name', 'view_key_hash', 'created_at'],
  members: ['slot', 'member_id', 'calendar_id', 'name', 'color', 'secret_hash', 'created_at'],
  calendar_events: ['id', 'calendar_id', 'member_id', 'title', 'start_date', 'end_date', 'version', 'created_at', 'updated_at'],
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function assertSnapshot(condition, message) {
  if (!condition) throw new Error(`Invalid database snapshot: ${message}`);
}

function exactRow(row, table, index) {
  assertSnapshot(row && typeof row === 'object' && !Array.isArray(row), `${table}[${index}] must be an object`);
  const expected = table === 'calendars' && !Object.hasOwn(row, 'view_key_hash') ? ['id', 'name', 'created_at'] : expectedKeys[table];
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  assertSnapshot(actual.length === wanted.length && actual.every((key, i) => key === wanted[i]), `${table}[${index}] has missing or unexpected columns`);
}

function requiredText(value, label) {
  assertSnapshot(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`);
  assertSnapshot(!value.includes('\0'), `${label} contains a NUL byte`);
  return value;
}

function validUuid(value, label) {
  requiredText(value, label);
  assertSnapshot(uuidPattern.test(value), `${label} must be a complete UUID`);
  return value;
}

function validDate(value, label) {
  requiredText(value, label);
  assertSnapshot(datePattern.test(value), `${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  assertSnapshot(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, `${label} is not a real calendar date`);
  return value;
}

function validTimestamp(value, label) {
  requiredText(value, label);
  assertSnapshot(timestampPattern.test(value), `${label} must be a complete SQLite timestamp`);
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  assertSnapshot(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 19).replace('T', ' ') === value, `${label} is not a real SQLite timestamp`);
  return value;
}

function validInteger(value, label) {
  assertSnapshot(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  return value;
}

function sqlText(value) {
  // All identifiers are fixed constants; values are encoded as SQL string literals.
  if (value === null) return 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function rowInsert(table, columns, values) {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.map((value) => typeof value === 'number' ? String(value) : sqlText(value)).join(', ')});`;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function transformSnapshot(snapshot) {
  assertSnapshot(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), 'root must be an object');
  const rootKeys = Object.keys(snapshot).sort();
  assertSnapshot(rootKeys.length === 3 && rootKeys[0] === 'calendar_events' && rootKeys[1] === 'calendars' && rootKeys[2] === 'members', 'root must contain only calendars, members, and calendar_events');
  for (const table of Object.keys(expectedKeys)) assertSnapshot(Array.isArray(snapshot[table]), `${table} must be an array`);

  const calendars = snapshot.calendars.map((row, index) => {
    exactRow(row, 'calendars', index);
    const viewKeyHash = row.view_key_hash ?? null;
    assertSnapshot(viewKeyHash === null || (typeof viewKeyHash === 'string' && /^[0-9a-f]{64}$/i.test(viewKeyHash)), `calendars[${index}].view_key_hash must be NULL or a full SHA-256 hex digest`);
    return {
      id: validUuid(row.id, `calendars[${index}].id`),
      name: requiredText(row.name, `calendars[${index}].name`),
      view_key_hash: viewKeyHash,
      created_at: validTimestamp(row.created_at, `calendars[${index}].created_at`),
    };
  });
  const calendarIds = new Set();
  for (const calendar of calendars) {
    assertSnapshot(!calendarIds.has(calendar.id), `duplicate calendar ID ${calendar.id}`);
    calendarIds.add(calendar.id);
  }

  const members = snapshot.members.map((row, index) => {
    exactRow(row, 'members', index);
    const slot = validInteger(row.slot, `members[${index}].slot`);
    const memberId = validUuid(row.member_id, `members[${index}].member_id`);
    const calendarId = validUuid(row.calendar_id, `members[${index}].calendar_id`);
    const name = requiredText(row.name, `members[${index}].name`);
    const color = requiredText(row.color, `members[${index}].color`);
    assertSnapshot(/^#[0-9a-f]{6}$/i.test(color), `members[${index}].color must be a six-digit hex color`);
    requiredText(row.secret_hash, `members[${index}].secret_hash`);
    assertSnapshot(/^[0-9a-f]{64}$/i.test(row.secret_hash), `members[${index}].secret_hash must be a full SHA-256 hex digest`);
    const createdAt = validTimestamp(row.created_at, `members[${index}].created_at`);
    assertSnapshot(calendarIds.has(calendarId), `members[${index}] references missing calendar ${calendarId}`);
    return { slot, member_id: memberId, calendar_id: calendarId, name, color, secret_hash: row.secret_hash, created_at: createdAt };
  });
  const memberIds = new Set();
  const slots = new Set();
  const calendarSecretHashes = new Set();
  for (const member of members) {
    assertSnapshot(!memberIds.has(member.member_id), `duplicate member ID ${member.member_id}`);
    assertSnapshot(!slots.has(member.slot), `duplicate member slot ${member.slot}`);
    const calendarSecretKey = `${member.calendar_id}\0${member.secret_hash}`;
    assertSnapshot(!calendarSecretHashes.has(calendarSecretKey), `duplicate member secret hash in calendar ${member.calendar_id}`);
    memberIds.add(member.member_id);
    slots.add(member.slot);
    calendarSecretHashes.add(calendarSecretKey);
  }

  const events = snapshot.calendar_events.map((row, index) => {
    exactRow(row, 'calendar_events', index);
    const id = validUuid(row.id, `calendar_events[${index}].id`);
    const calendarId = validUuid(row.calendar_id, `calendar_events[${index}].calendar_id`);
    const memberId = validUuid(row.member_id, `calendar_events[${index}].member_id`);
    const title = requiredText(row.title, `calendar_events[${index}].title`);
    const startDate = validDate(row.start_date, `calendar_events[${index}].start_date`);
    const endDate = validDate(row.end_date, `calendar_events[${index}].end_date`);
    const version = validInteger(row.version, `calendar_events[${index}].version`);
    const createdAt = validTimestamp(row.created_at, `calendar_events[${index}].created_at`);
    const updatedAt = validTimestamp(row.updated_at, `calendar_events[${index}].updated_at`);
    assertSnapshot(endDate >= startDate, `calendar_events[${index}] ends before it starts`);
    assertSnapshot(calendarIds.has(calendarId), `calendar_events[${index}] references missing calendar ${calendarId}`);
    const member = members.find((candidate) => candidate.member_id === memberId);
    assertSnapshot(member, `calendar_events[${index}] references missing member ${memberId}`);
    assertSnapshot(member.calendar_id === calendarId, `calendar_events[${index}] member belongs to a different calendar`);
    return { id, calendar_id: calendarId, member_id: memberId, title, start_date: startDate, end_date: endDate, version, created_at: createdAt, updated_at: updatedAt };
  });
  const eventIds = new Set();
  for (const event of events) {
    assertSnapshot(!eventIds.has(event.id), `duplicate event ID ${event.id}`);
    eventIds.add(event.id);
  }

  calendars.sort((a, b) => a.id.localeCompare(b.id));
  members.sort((a, b) => a.slot - b.slot);
  events.sort((a, b) => a.id.localeCompare(b.id));

  const statements = [...schemaStatements];
  for (const row of calendars) statements.push(rowInsert('calendars', ['id', 'name', 'view_key_hash', 'created_at'], [row.id, row.name, row.view_key_hash, row.created_at]));
  for (const row of members) statements.push(rowInsert('members', ['slot', 'member_id', 'calendar_id', 'name', 'color', 'secret_hash', 'created_at'], [row.slot, row.member_id, row.calendar_id, row.name, row.color, row.secret_hash, row.created_at]));
  for (const row of events) statements.push(rowInsert('calendar_events', ['id', 'calendar_id', 'member_id', 'title', 'start_date', 'end_date', 'version', 'created_at', 'updated_at'], [row.id, row.calendar_id, row.member_id, row.title, row.start_date, row.end_date, row.version, row.created_at, row.updated_at]));

  const sql = `${statements.join('\n\n')}\n`;
  const canonicalSnapshot = JSON.stringify({ calendars, members, calendar_events: events });
  const metadata = {
    formatVersion: 1,
    counts: { calendars: calendars.length, members: members.length, calendar_events: events.length },
    migrationSha256: digest(sql),
    sourceSnapshotSha256: digest(canonicalSnapshot),
  };
  return { sql, metadata };
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key !== '--input' && key !== '--output') throw new Error(`Unknown argument: ${key}`);
    if (parsed[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Expected a path after ${key}`);
    parsed[key] = args[++i];
  }
  if (!parsed['--input'] || !parsed['--output']) throw new Error('Usage: node scripts/calendar-snapshot.mjs --input <snapshot.json> --output <migration.sql>');
  return { input: path.resolve(parsed['--input']), output: path.resolve(parsed['--output']) };
}

async function atomicWritePair(sqlPath, sqlTextValue, metadataPath, metadataText) {
  const token = randomUUID();
  const sqlTemp = `${sqlPath}.${token}.tmp`;
  const metadataTemp = `${metadataPath}.${token}.tmp`;
  await mkdir(path.dirname(sqlPath), { recursive: true });
  await mkdir(path.dirname(metadataPath), { recursive: true });
  try {
    await Promise.all([
      writeFile(sqlTemp, sqlTextValue, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
      writeFile(metadataTemp, metadataText, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
    ]);
    await rename(sqlTemp, sqlPath);
    await rename(metadataTemp, metadataPath);
  } catch (error) {
    await Promise.all([rm(sqlTemp, { force: true }), rm(metadataTemp, { force: true })]);
    throw error;
  }
}

export async function runCli(args = process.argv.slice(2)) {
  const { input, output } = parseArgs(args);
  const snapshot = JSON.parse(await readFile(input, 'utf8'));
  const { sql, metadata } = transformSnapshot(snapshot);
  const metadataPath = output.replace(/\.sql$/i, '') + '.metadata.json';
  await atomicWritePair(output, sql, metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Snapshot migration written: ${metadata.counts.calendars} calendars, ${metadata.counts.members} members, ${metadata.counts.calendar_events} events.`);
  console.log(`Migration SHA-256: ${metadata.migrationSha256}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runCli();
  } catch (error) {
    console.error(`Snapshot migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
