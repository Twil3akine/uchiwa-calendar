import test from "node:test";
import assert from "node:assert/strict";
import { classifyTouchGesture, startTouchGesture } from "../lib/calendar-gesture.mjs";

test("horizontal touch swipes navigate months in the matching direction", () => {
  assert.equal(classifyTouchGesture(-90, 12, false, true, true), "next-month");
  assert.equal(classifyTouchGesture(82, -8, false, true, true), "previous-month");
});

test("short or mostly vertical movements are taps, not month navigation", () => {
  assert.equal(classifyTouchGesture(-40, 0, false, true, true), "tap");
  assert.equal(classifyTouchGesture(-90, 80, false, true, true), "tap");
});

test("a held touch creates a range only after dragging onto a calendar day", () => {
  assert.equal(classifyTouchGesture(35, 44, true, true, true), "range");
  assert.equal(classifyTouchGesture(0, 0, true, false, true), "held");
  assert.equal(classifyTouchGesture(35, 44, true, true, false), "held");
});

test("a long press takes precedence over horizontal swipe classification", () => {
  assert.equal(classifyTouchGesture(-120, 0, true, true, true), "range");
});

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(callback, delay) { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    run(id = 1) { const timer = timers.get(id); timers.delete(id); timer?.callback(); },
    get size() { return timers.size; },
  };
}

function touchEvent(type, properties = {}, cancelable = true) {
  return Object.assign(new Event(type, { cancelable }), properties);
}

function createSessionHarness() {
  const target = new EventTarget();
  const clock = fakeClock();
  const calls = { previews: [], created: [], months: [], suppressed: 0, finished: 0 };
  const stop = startTouchGesture({
    target, touchId: 7, startX: 10, startY: 10, anchor: "2026-10-01",
    findDay: (x, y) => x > 100 && y < 100 ? "2026-10-02" : "2026-10-01",
    onPreview: (start, end) => calls.previews.push([start, end]),
    onCreate: (start, end) => calls.created.push([start, end]),
    onNavigateMonth: direction => calls.months.push(direction),
    onSuppressClick: () => calls.suppressed++,
    onFinish: () => calls.finished++,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { target, clock, calls, stop };
}

test("touch session previews immediately at 400ms, updates while dragging, then creates once", () => {
  const { target, clock, calls } = createSessionHarness();
  assert.equal(clock.size, 1);
  clock.run();
  assert.deepEqual(calls.previews.at(-1), ["2026-10-01", "2026-10-01"]);
  const move = touchEvent("touchmove", { touches: [{ identifier: 7, clientX: 140, clientY: 10 }] });
  target.dispatchEvent(move);
  assert.equal(move.defaultPrevented, true);
  assert.deepEqual(calls.previews.at(-1), ["2026-10-01", "2026-10-02"]);
  target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
  assert.deepEqual(calls.created, [["2026-10-01", "2026-10-02"]]);
  assert.equal(calls.suppressed, 1);
  assert.equal(calls.finished, 1);
  target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
  assert.equal(calls.created.length, 1);
});

test("touch end follows the matching identifier and horizontal swipe navigates without selection", () => {
  const { target, calls } = createSessionHarness();
  target.dispatchEvent(touchEvent("touchmove", { touches: [{ identifier: 99, clientX: 300, clientY: 10 }] }));
  target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 99, clientX: 300, clientY: 10 }] }));
  assert.deepEqual(calls.months, []);
  target.dispatchEvent(touchEvent("touchmove", { touches: [{ identifier: 7, clientX: -70, clientY: 12 }] }));
  target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: -70, clientY: 12 }] }));
  assert.deepEqual(calls.months, [1]);
  assert.deepEqual(calls.created, []);
  assert.equal(calls.suppressed, 1);
});

test("vertical scroll cancels touch selection without preventing native movement", () => {
  const { target, calls, clock } = createSessionHarness();
  const move = touchEvent("touchmove", { touches: [{ identifier: 7, clientX: 12, clientY: 60 }] });
  target.dispatchEvent(move);
  assert.equal(move.defaultPrevented, false);
  assert.equal(clock.size, 0);
  clock.run();
  target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 12, clientY: 60 }] }));
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.months, []);
  assert.equal(calls.suppressed, 1);
});

test("multitouch and touchcancel terminate sessions and cannot create ranges", () => {
  const multi = createSessionHarness();
  multi.target.dispatchEvent(touchEvent("touchstart", { touches: [{ identifier: 7 }, { identifier: 8 }] }));
  multi.clock.run();
  multi.target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
  assert.deepEqual(multi.calls.previews, [[null, null]]);
  assert.deepEqual(multi.calls.created, []);
  assert.equal(multi.calls.suppressed, 1);

  const canceled = createSessionHarness();
  canceled.clock.run();
  canceled.target.dispatchEvent(touchEvent("touchcancel"));
  canceled.target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
  assert.deepEqual(canceled.calls.created, []);
  assert.equal(canceled.calls.suppressed, 1);
});

test("explicit cleanup removes listeners and suppresses a held gesture click", () => {
  const { target, clock, calls, stop } = createSessionHarness();
  clock.run();
  stop();
  target.dispatchEvent(touchEvent("touchmove", { touches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
  target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
  assert.deepEqual(calls.created, []);
  assert.equal(calls.suppressed, 1);
  assert.equal(calls.finished, 1);
});

test("blur and Escape cancel a held gesture and remove its listeners", () => {
  for (const event of [new Event("blur"), Object.assign(new Event("keydown"), { key: "Escape" })]) {
    const { target, clock, calls } = createSessionHarness();
    clock.run();
    target.dispatchEvent(event);
    target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
    assert.deepEqual(calls.created, []);
    assert.equal(calls.suppressed, 1);
    assert.equal(calls.finished, 1);
  }
});

test("a held gesture cancels if touchmove is no longer cancelable", () => {
  const { target, clock, calls } = createSessionHarness();
  clock.run();
  const move = touchEvent("touchmove", { touches: [{ identifier: 7, clientX: 140, clientY: 10 }] }, false);
  target.dispatchEvent(move);
  assert.equal(move.defaultPrevented, false);
  target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
  assert.deepEqual(calls.created, []);
  assert.equal(calls.suppressed, 1);
  assert.equal(calls.finished, 1);
});

test("native scroll after a hold cancels selection and suppresses the follow-up click", () => {
  const { target, clock, calls } = createSessionHarness();
  clock.run();
  target.dispatchEvent(new Event("scroll"));
  target.dispatchEvent(touchEvent("touchend", { changedTouches: [{ identifier: 7, clientX: 140, clientY: 10 }] }));
  assert.deepEqual(calls.created, []);
  assert.equal(calls.suppressed, 1);
  assert.equal(calls.finished, 1);
});
