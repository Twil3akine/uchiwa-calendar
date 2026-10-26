import { createHash } from "node:crypto";

export function makeBridgeScript(origin) {
  const target = new URL(origin);
  if (target.protocol !== "https:" || target.origin !== origin) throw new Error("Redirect destination must be an HTTPS origin.");
  return `(() => {
  const current = new URL(window.location.href);
  const destination = new URL(${JSON.stringify(origin)});
  destination.pathname = current.pathname;
  destination.search = current.search;
  destination.hash = current.hash;
  const fragment = new URLSearchParams(current.hash.slice(1));
  const calendar = current.searchParams.get("c");
  if (!fragment.has("person") && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(calendar || "")) {
    let secret;
    try { secret = window.localStorage.getItem("uchiwa:secret:" + calendar); } catch {}
    if (/^[A-Za-z0-9_-]{43}$/.test(secret || "")) {
      fragment.set("person", secret);
      destination.hash = fragment.toString();
    }
  }
  window.location.replace(destination.href);
})();`;
}

export function makeCalendarRedirectWorkerSource(origin) {
  const script = makeBridgeScript(origin);
  const hash = createHash("sha256").update(script).digest("base64");
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>うちわカレンダーへ移動</title><p>新しいカレンダーへ移動しています。</p><p><a href="${origin}/">新しいURLを開く</a></p><script>${script}</script></html>`;
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  return `const ORIGIN = ${JSON.stringify(origin)};
const HTML = ${JSON.stringify(html)};
const HEADERS = ${JSON.stringify(headers)};
export default { async fetch(request) {
  const incoming = new URL(request.url);
  if (incoming.pathname === "/api" || incoming.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(request.method)) {
    return new Response(JSON.stringify({ error: "このカレンダーは移転しました。新しいURLを開いてください。", url: ORIGIN }), { status: 409, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
  }
  if (request.method === "GET" && (request.headers.get("Accept") || "").includes("text/html")) {
    return new Response(HTML, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": ${JSON.stringify(`default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)} } });
  }
  return new Response(null, { status: 307, headers: { ...HEADERS, Location: ORIGIN + incoming.pathname + incoming.search } });
} };
`;
}
