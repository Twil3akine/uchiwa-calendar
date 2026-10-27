import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const root=path.resolve('dist/server');
const files=await readdir(root,{recursive:true});
const modules=['index.js',...files.filter(p=>p.endsWith('.js')&&p!=='index.js')].map(p=>({type:'ESModule',path:path.join(root,p)}));
const mf=new Miniflare(convertV4MiniflareOptions({modules,modulesRoot:root,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],cf:false,ratelimits:{CREATE_LIMIT:{namespace_id:'913421',simple:{limit:5,period:60}},WRITE_LIMIT:{namespace_id:'913422',simple:{limit:60,period:60}},READ_LIMIT:{namespace_id:'913423',simple:{limit:120,period:60}}}}));
const requiredDirectives = new Map([
  ['frame-ancestors', ["'none'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['connect-src', ["'self'"]],
  ['form-action', ["'self'"]],
  ['worker-src', ["'self'"]],
  ['manifest-src', ["'self'"]],
  ['media-src', ["'self'"]],
  ['img-src', ["'self'"]],
  ['font-src', ["'self'"]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
]);
function checkCsp(response) {
  const value=response.headers.get('content-security-policy');
  assert.ok(value, 'CSP header is present');
  const directives=new Map(value.split(';').map(part=>part.trim().split(/\s+/)).filter(([name])=>name).map(([name,...sources])=>[name,sources]));
  assert.equal(directives.has('default-src'),false,'default-src stays absent');
  for (const [name,sources] of requiredDirectives) assert.deepEqual(directives.get(name),sources,`CSP ${name}`);
  assert.deepEqual([...directives.keys()].sort(),[...requiredDirectives.keys()].sort(),'only reviewed CSP directives are present');
  for (const [name,sources] of directives) {
    assert.equal(sources.includes('*'),false,`${name} does not allow wildcard sources`);
    assert.equal(sources.includes("'unsafe-eval'"),false,`${name} does not allow unsafe-eval`);
    if (name!=='style-src') assert.equal(sources.includes("'unsafe-inline'"),false,`${name} does not allow unsafe-inline`);
  }
}
function inlineScriptHashes(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([,attributes])=>!/(?:^|\s)src\s*=/i.test(attributes))
    .map(([, ,body])=>`sha256-${createHash('sha256').update(body).digest('base64')}`)
    .sort();
}
try {
  const db=await mf.getD1Database('DB');
  const sql=await readFile('drizzle/0000_lean_omega_red.sql','utf8');
  await db.batch(sql.split(/-->\s*statement-breakpoint/g).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  const page=await mf.dispatchFetch('https://test.local/');
  assert.equal(page.status,200);
  checkCsp(page);
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  assert.equal(page.headers.get('cache-control'),'no-store');
  const html=await page.text();
  const cspSamples=[{path:'/',status:page.status,hashes:inlineScriptHashes(html)}];
  const meta=(name)=>{
    const tag=html.match(new RegExp(`<meta[^>]*(?:property|name)="${name}"[^>]*>`))?.[0];
    return tag?.match(/content="([^"]*)"/)?.[1];
  };
  assert.equal(meta('og:image'),'https://uchiwa-calendar.twil3akine.workers.dev/og.png');
  assert.equal(new URL(meta('og:url')).href,'https://uchiwa-calendar.twil3akine.workers.dev/');
  assert.equal(meta('twitter:card'),'summary_large_image');
  const png=await readFile('public/og.png');
  assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),630);
  const shared=await mf.dispatchFetch('https://test.local/?c=00000000-0000-4000-8000-000000000001');
  checkCsp(shared);
  const sharedHtml=await shared.text();
  cspSamples.push({path:'/?c=...0001',status:shared.status,hashes:inlineScriptHashes(sharedHtml)});
  assert.ok(sharedHtml.includes('https://uchiwa-calendar.twil3akine.workers.dev/og.png'));
  for (const [pathName,url] of [
    ['/', 'https://test.local/'],
    ['/?c=...0002', 'https://test.local/?c=00000000-0000-4000-8000-000000000002'],
    ['/not-found-csp-check', 'https://test.local/not-found-csp-check'],
  ]) {
    const response=await mf.dispatchFetch(url);
    checkCsp(response);
    const responseHtml=await response.text();
    if (pathName==='/not-found-csp-check') assert.equal(response.status,404);
    else assert.equal(response.status,200);
    cspSamples.push({path:pathName,status:response.status,hashes:inlineScriptHashes(responseHtml)});
  }
  const hashSets=cspSamples.map(sample=>JSON.stringify(sample.hashes));
  console.log(`Inline script SHA-256 measurement: ${new Set(hashSets).size===1?'stable':'varies'} across ${cspSamples.length} responses (${cspSamples.map(({path:samplePath,status,hashes})=>`${samplePath}=${status}:${hashes.length}`).join(', ')}).`);
  async function send(endpoint,body,cookie,method='POST') {
    return mf.dispatchFetch('https://test.local'+endpoint,{method,headers:{Origin:'https://test.local','Content-Type':'application/json','CF-Connecting-IP':'203.0.113.9',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  }
  const created=await send('/api/calendars',{name:'build smoke'});assert.equal(created.status,201);
  const cid=(await created.json()).calendar.id;
  const joined=await send(`/api/calendars/${cid}/members`,{name:'member',secret:'a'.repeat(43)});assert.equal(joined.status,201);
  assert.ok(joined.headers.get('set-cookie').includes('Secure'));
  const cookie=joined.headers.get('set-cookie').split(';')[0];
  const rotated=await send(`/api/calendars/${cid}/session`,{confirm:true,secret:'b'.repeat(43)},cookie,'PATCH');assert.equal(rotated.status,200);
  assert.equal(rotated.headers.get('cache-control'),'no-store');await rotated.arrayBuffer();
  assert.equal((await send(`/api/calendars/${cid}/session`,{secret:'a'.repeat(43)})).status,401);
  assert.equal((await send(`/api/calendars/${cid}/session`,{secret:'b'.repeat(43)})).status,200);
  console.log('Built Worker: CSP directives, HTML security headers, D1 bindings, secure cookies and personal-link revocation passed.');
}finally{await mf.dispose();}
