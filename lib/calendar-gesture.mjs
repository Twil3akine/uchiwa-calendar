export function classifyTouchGesture(dx, dy, longPressed, moved, landedOnDay) {
  if (!longPressed && Math.abs(dx) >= 55 && Math.abs(dx) > Math.abs(dy) * 1.35) {
    return dx < 0 ? "next-month" : "previous-month";
  }
  if (longPressed) return moved && landedOnDay ? "range" : "held";
  return "tap";
}

export function startTouchGesture({
  target,
  touchId,
  startX,
  startY,
  anchor,
  findDay,
  onPreview,
  onCreate,
  onNavigateMonth,
  onSuppressClick,
  onFinish = () => {},
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  let ended = false;
  let longPressed = false;
  let moved = false;
  let holdTimer;
  const cleanupListeners = [];
  const listen = (type, listener, options) => {
    target.addEventListener(type, listener, options);
    cleanupListeners.push(() => target.removeEventListener(type, listener, options));
  };
  const finish = (suppress = false) => {
    if (ended) return;
    ended = true;
    if (holdTimer !== undefined) clearTimer(holdTimer);
    for (const remove of cleanupListeners) remove();
    onPreview(null, null);
    if (suppress) onSuppressClick();
    onFinish();
  };

  holdTimer = setTimer(() => {
    if (ended) return;
    longPressed = true;
    onPreview(anchor, anchor);
  }, 400);

  listen("touchstart", (event) => {
    if (event.touches.length > 1) finish(true);
  }, { passive: true });
  listen("touchmove", (event) => {
    if (ended) return;
    const touch = Array.from(event.touches).find((item) => item.identifier === touchId);
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    const distance = Math.hypot(dx, dy);
    if (!longPressed && distance > 10) {
      if (holdTimer !== undefined) clearTimer(holdTimer);
      holdTimer = undefined;
      if (Math.abs(dy) > Math.abs(dx)) finish(true);
      return;
    }
    if (!longPressed) return;
    if (!event.cancelable) { finish(true); return; }
    event.preventDefault();
    moved ||= distance > 4;
    const day = findDay(touch.clientX, touch.clientY);
    if (day) onPreview(anchor, day);
  }, { passive: false });
  listen("touchend", (event) => {
    if (ended) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === touchId);
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    const day = findDay(touch.clientX, touch.clientY);
    const gesture = classifyTouchGesture(dx, dy, longPressed, moved, Boolean(day));
    if (gesture === "next-month" || gesture === "previous-month") {
      finish(true);
      onNavigateMonth(gesture === "next-month" ? 1 : -1);
      return;
    }
    if (gesture === "range" && day) onCreate(anchor, day);
    finish(gesture === "range" || gesture === "held");
  }, { passive: true });
  listen("touchcancel", () => finish(true), { passive: true });
  listen("scroll", () => finish(longPressed), { capture: true, passive: true });
  listen("blur", () => finish(longPressed), { passive: true });
  listen("keydown", (event) => { if (event.key === "Escape") finish(longPressed); }, { passive: true });

  return () => finish(longPressed);
}
