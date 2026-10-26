import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { makeBridgeScript, makeCalendarRedirectWorkerSource } from "../scripts/calendar-redirect.mjs";

const origin = "https://uchiwa-calendar.twil3akine.workers.dev";
const calendar = "11111111-2222-4333-8444-555555555555";
const secret = "a".repeat(43);

function navigate(suffix, storage) {
  let destination;
  const window = {
    location: { href: `https://old.example/${suffix}`, replace(url) { destination = url; } },
    localStorage: { getItem(key) { assert.equal(key, `uchiwa:secret:${calendar}`); if (storage instanceof Error) throw storage; return storage; } },
  };
  vm.runInNewContext(makeBridgeScript(origin), { window, URL, URLSearchParams });
  return new URL(destination);
}

test("shared bookmarks preserve a stored identity in the fragment only", () => {
  const target = navigate(`?c=${calendar}&month=2026-10`, secret);
  assert.equal(target.origin, origin);
  assert.equal(target.search, `?c=${calendar}&month=2026-10`);
  assert.equal(target.hash, `#person=${secret}`);
});

test("an explicit personal link takes priority over stored identity", () => {
  const target = navigate(`?c=${calendar}#person=${"b".repeat(43)}`, secret);
  assert.equal(target.hash, `#person=${"b".repeat(43)}`);
});

test("missing, invalid or inaccessible storage still navigates", () => {
  for (const stored of [null, "invalid", new Error("storage blocked")]) {
    const target = navigate(`?c=${calendar}#view=month`, stored);
    assert.equal(target.hash, "#view=month");
    assert.equal(target.origin, origin);
  }
  assert.equal(navigate("?c=invalid&next=https://other.example", secret).origin, origin);
});

test("generated Worker bridges documents, redirects other reads and blocks API replay", async () => {
  const source = makeCalendarRedirectWorkerSource(origin);
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const response = await worker.fetch(new Request(`https://old.example/?c=${calendar}`, { headers: { Accept: "text/html" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(response.headers.get("content-security-policy").includes(`'sha256-${hash}'`));
  assert.ok(!html.includes(calendar));
  assert.ok(!html.includes(secret));
  const redirect = await worker.fetch(new Request("https://old.example/path?c=123"));
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), `${origin}/path?c=123`);
  for (const request of [new Request("https://old.example/api/calendars"), new Request("https://old.example/", { method: "POST" })]) {
    assert.equal((await worker.fetch(request)).status, 409);
  }
  assert.throws(() => makeBridgeScript("http://other.example"), /HTTPS origin/);
});
