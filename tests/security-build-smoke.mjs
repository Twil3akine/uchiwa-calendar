import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const root=path.resolve('dist/server');
const files=await readdir(root,{recursive:true});
const modules=['index.js',...files.filter(p=>p.endsWith('.js')&&p!=='index.js')].map(p=>({type:'ESModule',path:path.join(root,p)}));
const mf=new Miniflare(convertV4MiniflareOptions({modules,modulesRoot:root,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],cf:false,ratelimits:{CREATE_LIMIT:{namespace_id:'913421',simple:{limit:5,period:60}},WRITE_LIMIT:{namespace_id:'913422',simple:{limit:60,period:60}},READ_LIMIT:{namespace_id:'913423',simple:{limit:120,period:60}}}}));
try {
  const db=await mf.getD1Database('DB');
  const migrationFiles=(await readdir('drizzle')).filter(file=>file.endsWith('.sql')).sort();
  for(const file of migrationFiles) {
    const sql=await readFile(path.join('drizzle',file),'utf8');
    await db.batch(sql.split(/-->\s*statement-breakpoint/g).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  }
  const page=await mf.dispatchFetch('https://test.local/');
  assert.equal(page.status,200);
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  assert.equal(page.headers.get('cache-control'),'no-store');
  const html=await page.text();
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
  const sharedHtml=await shared.text();
  assert.ok(sharedHtml.includes('https://uchiwa-calendar.twil3akine.workers.dev/og.png'));
  async function send(endpoint,body,cookie,method='POST',viewKey) {
    return mf.dispatchFetch('https://test.local'+endpoint,{method,headers:{Origin:'https://test.local','Content-Type':'application/json','CF-Connecting-IP':'203.0.113.9',...(cookie?{Cookie:cookie}:{}),...(viewKey?{'X-View-Key':viewKey}:{})},body:JSON.stringify(body)});
  }
  const created=await send('/api/calendars',{name:'build smoke',viewKey:'v'.repeat(43)});assert.equal(created.status,201);
  const cid=(await created.json()).calendar.id;
  const joined=await send(`/api/calendars/${cid}/members`,{name:'member',secret:'a'.repeat(43)},undefined,'POST','v'.repeat(43));assert.equal(joined.status,201);
  assert.ok(joined.headers.get('set-cookie').includes('Secure'));
  const cookie=joined.headers.get('set-cookie').split(';')[0];
  const rotated=await send(`/api/calendars/${cid}/session`,{confirm:true,secret:'b'.repeat(43)},cookie,'PATCH');assert.equal(rotated.status,200);
  assert.equal(rotated.headers.get('cache-control'),'no-store');await rotated.arrayBuffer();
  assert.equal((await send(`/api/calendars/${cid}/session`,{secret:'a'.repeat(43)})).status,401);
  assert.equal((await send(`/api/calendars/${cid}/session`,{secret:'b'.repeat(43)})).status,200);
  console.log('Built Worker: HTML security headers, D1 bindings, secure cookies and personal-link revocation passed.');
}finally{await mf.dispose();}
