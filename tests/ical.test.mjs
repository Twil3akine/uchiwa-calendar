import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeIcalText, foldIcalLine, generateIcalFeed } from '../lib/ical.ts';

const event = (overrides = {}) => ({
  id: 'event-1', title: 'Plan', startDate: '2024-02-28', endDate: '2024-02-29',
  updatedAt: '2026-10-27 12:34:56', memberName: 'さくら', ...overrides,
});

test('generates a multi-day event with exclusive end date and UTC DTSTAMP', () => {
  const ics = generateIcalFeed({ calendarName: '家族', events: [event()] });
  assert.match(ics, /BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /VERSION:2\.0\r\nCALSCALE:GREGORIAN\r\n/);
  assert.match(ics, /UID:event-1@uchiwa-calendar\r\n/);
  assert.match(ics, /DTSTAMP:20261027T123456Z\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20240228\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20240301\r\n/);
  assert.match(ics, /DESCRIPTION:さくら\r\n/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('advances month end, year end, leap day, non-leap century, and caps year 9999', () => {
  const ics = generateIcalFeed({ calendarName: 'dates', events: [
    event({ id: 'month', endDate: '2026-04-30' }),
    event({ id: 'year', endDate: '2026-12-31' }),
    event({ id: 'leap', endDate: '2024-02-29' }),
    event({ id: 'century', endDate: '2100-02-28' }),
    event({ id: 'max', endDate: '9999-12-31' }),
  ] });
  assert.match(ics, /UID:month@uchiwa-calendar\r\n[\s\S]*?DTEND;VALUE=DATE:20260501/);
  assert.match(ics, /UID:year@uchiwa-calendar\r\n[\s\S]*?DTEND;VALUE=DATE:20270101/);
  assert.match(ics, /UID:leap@uchiwa-calendar\r\n[\s\S]*?DTEND;VALUE=DATE:20240301/);
  assert.match(ics, /UID:century@uchiwa-calendar\r\n[\s\S]*?DTEND;VALUE=DATE:21000301/);
  assert.match(ics, /UID:max@uchiwa-calendar\r\n[\s\S]*?DTEND;VALUE=DATE:99991231/);
});

test('escapes text and normalizes newlines and controls in all text fields', () => {
  assert.equal(escapeIcalText('a\\b;c,d\r\ne\rf\ng:\u0001'), 'a\\\\b\\;c\\,d\\ne\\nf\\ng:');
  const ics = generateIcalFeed({ calendarName: 'Cal\r\nBEGIN:VEVENT', events: [event({ title: 'T;\r\nUID:forged', memberName: 'M,\u0000x' })] });
  assert.match(ics, /X-WR-CALNAME:Cal\\nBEGIN:VEVENT\r\n/);
  assert.match(ics, /SUMMARY:T\\;\\nUID:forged\r\n/);
  assert.match(ics, /DESCRIPTION:M\\,x\r\n/);
  assert.equal((ics.match(/^BEGIN:VEVENT$/gm) || []).length, 1);
});

test('folding respects 74, 75, and 76 octet boundaries and can be unfolded', () => {
  for (const length of [74, 75, 76]) {
    const folded = foldIcalLine('a'.repeat(length));
    const lines = folded.split('\r\n');
    assert.equal(lines.map((line) => Buffer.byteLength(line)).every((size) => size <= 75), true);
    assert.equal(folded.replace(/\r\n /g, ''), 'a'.repeat(length));
    assert.equal(lines.length, length === 76 ? 2 : 1);
  }
  const multibyte = foldIcalLine('あ'.repeat(30));
  assert.ok(multibyte.split('\r\n').every((line) => Buffer.byteLength(line) <= 75));
  assert.equal(multibyte.replace(/\r\n /g, ''), 'あ'.repeat(30));
});

test('folding accounts for property names and continuation whitespace', () => {
  const ics = generateIcalFeed({ calendarName: 'カ'.repeat(40), events: [event({ title: '予'.repeat(40) })] });
  for (const line of ics.split('\r\n').filter(Boolean)) assert.ok(Buffer.byteLength(line) <= 75, `${Buffer.byteLength(line)} octets: ${line}`);
});

test('supports an empty calendar', () => {
  assert.equal(generateIcalFeed({ calendarName: 'Empty', events: [] }), [
    'BEGIN:VCALENDAR', 'PRODID:-//uchiwa-calendar//iCalendar Feed//JA', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Empty', 'END:VCALENDAR', '',
  ].join('\r\n'));
});
