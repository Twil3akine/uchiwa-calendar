import test from 'node:test';
import assert from 'node:assert/strict';
import { dateRange, layoutWeek } from '../lib/calendar-layout.ts';

const days = ['2027-02-14', '2027-02-15', '2027-02-16', '2027-02-17', '2027-02-18', '2027-02-19', '2027-02-20'];
const event = (id, startDate, endDate = startDate) => ({ id, startDate, endDate, title: id, memberId: 'member', version: 1 });

test('selection includes both ends and normalizes reverse drags', () => {
  assert.deepEqual(dateRange(days[5], days[1]), { startDate: days[1], endDate: days[5] });
  assert.deepEqual(dateRange(days[1], days[5]), dateRange(days[5], days[1]));
  assert.deepEqual(dateRange(days[0], days[0]), { startDate: days[0], endDate: days[0] });
});
test('multi-day events use one continuous span and wrap at week edges', () => {
  const [span] = layoutWeek(days, [event('trip', '2027-02-15', '2027-02-26')]);
  assert.deepEqual([span.start, span.end, span.startsHere, span.endsHere], [1, 7, true, false]);
  const next = days.map(d => '2027-02-' + (Number(d.slice(-2)) + 7));
  const [continuation] = layoutWeek(next, [span.event]);
  assert.deepEqual([continuation.start, continuation.end, continuation.startsHere, continuation.endsHere], [0, 6, false, true]);
});
test('overlapping bands never share a lane; nonoverlapping bands reuse it', () => {
  const spans = layoutWeek(days, [event('a', days[0], days[2]), event('b', days[2], days[3]), event('c', days[4])]);
  assert.notEqual(spans[0].lane, spans[1].lane);
  assert.equal(spans[0].lane, spans[2].lane);
});
test('clips month-spanning events and hides events outside the visible week', () => {
  const spans = layoutWeek(days, [event('long', '2027-01-30', '2027-03-01'), event('outside', '2027-04-01')]);
  assert.equal(spans.length, 1);
  assert.deepEqual([spans[0].start, spans[0].end, spans[0].startsHere, spans[0].endsHere], [0, 7, false, false]);
  assert.deepEqual(layoutWeek([], []), []);
});
test('lane assignment is stable regardless of server event order', () => {
  const events = [event('b', days[0], days[4]), event('a', days[0], days[4]), event('c', days[1])];
  assert.deepEqual(layoutWeek(days, events), layoutWeek(days, [...events].reverse()));
});
