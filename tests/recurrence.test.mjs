import test from 'node:test';
import assert from 'node:assert/strict';
import { expandRecurrence, normalizeRecurrence } from '../lib/recurrence.mjs';

test('expands weekly occurrences across month and year boundaries, including leap day', () => {
  assert.deepEqual(expandRecurrence('2024-02-29', { freq: 'weekly', until: null, count: 3 }), ['2024-02-29', '2024-03-07', '2024-03-14']);
  assert.deepEqual(expandRecurrence('2023-12-29', { freq: 'weekly', until: null, count: 3 }), ['2023-12-29', '2024-01-05', '2024-01-12']);
});

test('includes the start and the earlier of until and count', () => {
  assert.deepEqual(expandRecurrence('2026-01-01', { freq: 'weekly', until: '2026-01-15', count: 5 }), ['2026-01-01', '2026-01-08', '2026-01-15']);
  assert.deepEqual(expandRecurrence('2026-01-01', { freq: 'weekly', until: '2026-02-01', count: 2 }), ['2026-01-01', '2026-01-08']);
  assert.deepEqual(expandRecurrence('2026-01-01', { freq: 'weekly', until: '2025-12-31', count: null }), []);
});

test('accepts the 53 occurrence boundary and rejects invalid rules', () => {
  const rule = normalizeRecurrence({ freq: 'weekly', count: 53 }, '2026-01-01');
  assert.equal(expandRecurrence('2026-01-01', rule).length, 53);
  assert.throws(() => normalizeRecurrence({ freq: 'weekly', count: 54 }, '2026-01-01'));
  assert.throws(() => normalizeRecurrence({ freq: 'daily', count: 2 }, '2026-01-01'));
  assert.throws(() => normalizeRecurrence({ freq: 'weekly' }, '2026-01-01'));
  assert.throws(() => normalizeRecurrence({ freq: 'weekly', count: 1 }, '2026-01-01'));
  assert.throws(() => normalizeRecurrence({ freq: 'weekly', until: '2025-12-31' }, '2026-01-01'));
  assert.throws(() => normalizeRecurrence({ freq: 'weekly', until: '2027-01-02' }, '2026-01-01'));
  assert.throws(() => normalizeRecurrence({ freq: 'weekly', until: '2026-02-30' }, '2026-01-01'));
});
