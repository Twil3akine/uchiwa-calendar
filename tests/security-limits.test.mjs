import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { layoutWeek } from '../lib/calendar-layout.ts';

const require = createRequire(import.meta.resolve('wrangler/package.json'));
const esbuild = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = await esbuild.build({ entryPoints: [fileURLToPath(new URL('./api-worker.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], write: false });

export async function fixture() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: source.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], cf: false,
    ratelimits: Object.fromEntries([['CREATE_LIMIT',5],['WRITE_LIMIT',60],['READ_LIMIT',120]].map(([name,limit],i)=>[name,{namespace_id:String(913421+i),simple:{limit,period:60}}])) }));
  const db = await mf.getD1Database('DB');
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const file of (await readdir(migrationDir)).filter(name => /^\d+_.*\.sql$/.test(name)).sort()) {
    const sql = await readFile(new URL(file, migrationDir), 'utf8');
    await db.batch(sql.split(/-->\s*statement-breakpoint/g).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  }
  async function request(path, method='GET', body, cookie, ip='203.0.113.1') {
    return mf.dispatchFetch('https://test.local'+path,{method,headers:{Origin:'https://test.local','Content-Type':'application/json','CF-Connecting-IP':ip,...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  }
  const cid=crypto.randomUUID();
  await db.prepare('INSERT INTO calendars (id,name) VALUES (?,?)').bind(cid,'security fixture').run();
  const joined=await request(`/api/calendars/${cid}/members`,'POST',{name:'owner',secret:'a'.repeat(43)});
  assert.equal(joined.status,201);
  const member=(await joined.json()).member;
  const cookie=joined.headers.get('set-cookie').split(';')[0];
  return {mf,db,cid,member,cookie,request};
}

test('native rate limiter rejects excessive anonymous creation with 429 and Retry-After',async()=>{
  const f=await fixture();try {
    const results=[];for(let i=0;i<7;i++)results.push(await f.request('/api/calendars','POST',{name:'test'}));
    assert.equal(results[0].status,201);assert.equal(results.at(-1).status,429);
    assert.equal(results.at(-1).headers.get('retry-after'),'60');
    assert.equal((await f.request('/api/calendars','POST',{name:'another'},undefined,'203.0.113.2')).status,201);
  }finally{await f.mf.dispose();}
});
test('missing rate-limit bindings fail closed before touching the database',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:source.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],cf:false}));
  try {
    const res=await mf.dispatchFetch('https://test.local/api/calendars',{method:'POST',headers:{Origin:'https://test.local','Content-Type':'application/json'},body:JSON.stringify({name:'blocked'})});
    assert.equal(res.status,503);
  }finally{await mf.dispose();}
});
test('calendar quota is atomic under concurrent inserts',async()=>{
  const f=await fixture();try {
    await f.db.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4998) INSERT INTO calendars(id,name) SELECT printf('seed-%d',x),'seed' FROM n").run();
    const res=await Promise.all([f.request('/api/calendars','POST',{name:'a'}),f.request('/api/calendars','POST',{name:'b'})]);
    assert.deepEqual(res.map(r=>r.status).sort(),[201,409]);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM calendars').first()).n,5000);
  }finally{await f.mf.dispose();}
});
test('member and event caps preserve existing data, retries and concurrent boundaries',async()=>{
  const f=await fixture();try {
    const members=Array.from({length:48},(_,i)=>f.db.prepare('INSERT INTO members(member_id,calendar_id,name,secret_hash) VALUES (?,?,?,?)').bind(crypto.randomUUID(),f.cid,'seed','seed-'+i));
    await f.db.batch(members);
    const res=await Promise.all(['b','c'].map(s=>f.request(`/api/calendars/${f.cid}/members`,'POST',{name:s,secret:s.repeat(43)})));
    assert.deepEqual(res.map(r=>r.status).sort(),[201,409]);
    await f.db.batch(Array.from({length:199},()=>f.db.prepare('INSERT INTO calendar_events(id,calendar_id,member_id,title,start_date,end_date) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),f.cid,f.member.id,'seed','2026-10-26','2026-10-26')));
    const body={id:crypto.randomUUID(),title:'boundary',startDate:'2026-10-26',endDate:'2026-10-26',recurrence:{freq:'weekly',count:2}};
    const posts=await Promise.all([f.request(`/api/calendars/${f.cid}/events`,'POST',body,f.cookie),f.request(`/api/calendars/${f.cid}/events`,'POST',{...body,id:crypto.randomUUID()},f.cookie)]);
    assert.deepEqual(posts.map(r=>r.status).sort(),[201,409]);
    const accepted=await posts.find(r=>r.status===201).json();
    const retry=await f.request(`/api/calendars/${f.cid}/events`,'POST',{...body,id:accepted.event.id},f.cookie);
    assert.equal(retry.status,200);
    assert.equal(retry.headers.get('content-type').includes('application/json'),true);
    assert.equal((await f.db.prepare('SELECT repeat_freq FROM calendar_events WHERE id=?').bind(accepted.event.id).first()).repeat_freq,'weekly');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM calendar_events').first()).n,200);
  }finally{await f.mf.dispose();}
});
test('streamed input is cancelled before reading an oversized body in full',async()=>{
  const compiled=await esbuild.transform(await readFile(new URL('../lib/server/http.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
  const {readJson}=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
  let chunks=0,cancelled=false;
  const body=new ReadableStream({pull(c){chunks++;if(chunks<=100)c.enqueue(new Uint8Array(1024));else c.close();},cancel(){cancelled=true;}});
  await assert.rejects(readJson(new Request('https://test.local',{method:'POST',headers:{'content-type':'application/json'},body,duplex:'half'}),2048),e=>e.status===413);
  assert.ok(chunks<10);assert.equal(cancelled,true);
});
test('calendar-wide event quota is enforced even when the writer is below their own cap',async()=>{
  const f=await fixture();try {
    const other=crypto.randomUUID();
    await f.db.prepare('INSERT INTO members(member_id,calendar_id,name,secret_hash) VALUES (?,?,?,?)').bind(other,f.cid,'legacy','legacy').run();
    await f.db.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<999) INSERT INTO calendar_events(id,calendar_id,member_id,title,start_date,end_date) SELECT printf('seed-event-%d',x),?,?,'legacy','2026-10-26','2026-10-26' FROM n").bind(f.cid,other).run();
    const body={title:'boundary recurring series',startDate:'2026-10-26',endDate:'2026-10-26',recurrence:{freq:'weekly',count:2}};
    const res=await Promise.all([1,2].map(()=>f.request(`/api/calendars/${f.cid}/events`,'POST',{...body,id:crypto.randomUUID()},f.cookie)));
    assert.deepEqual(res.map(r=>r.status).sort(),[201,409]);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM calendar_events').first()).n,1000);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE repeat_freq='weekly'").first()).n,1);
  }finally{await f.mf.dispose();}
});
test('dense event bands use at most three visible lanes with overflow markers',()=>{
  const days=['2026-10-25','2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31'];
  const spans=layoutWeek(days,Array.from({length:1000},(_,i)=>({id:String(i),memberId:'m',title:'busy',startDate:days[0],endDate:days[6],version:1})),3);
  assert.equal(spans.filter(s=>s.lane<3).length,3);assert.equal(spans.filter(s=>s.lane===3).length,997);
});

test('rotation revokes old cookies and links while preserving identity, color and event ownership',async()=>{
  const f=await fixture();try {
    const base=`/api/calendars/${f.cid}`;
    const draft={id:crypto.randomUUID(),title:'keep me',startDate:'2026-10-26',endDate:'2026-10-28'};
    assert.equal((await f.request(base+'/events','POST',draft,f.cookie)).status,201);
    assert.equal((await f.request(base+'/session','PATCH',{confirm:true,secret:'b'.repeat(43)})).status,401);
    assert.equal((await f.request(base+'/session','PATCH',{confirm:false,secret:'b'.repeat(43)},f.cookie)).status,400);
    const cross=await f.mf.dispatchFetch('https://test.local'+base+'/session',{method:'PATCH',headers:{Origin:'https://evil.local','Content-Type':'application/json',Cookie:f.cookie},body:JSON.stringify({confirm:true,secret:'b'.repeat(43)})});
    assert.equal(cross.status,403);
    const response=await f.request(base+'/session','PATCH',{confirm:true,secret:'b'.repeat(43)},f.cookie);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const result=await response.json();assert.deepEqual(result.member,f.member);
    const cookie=response.headers.get('set-cookie').split(';')[0];
    assert.equal((await f.request(base+'/session','PATCH',{confirm:true,secret:'b'.repeat(43)},cookie)).status,200);
    assert.equal((await f.request(base+'/session','POST',{secret:'a'.repeat(43)})).status,401);
    assert.equal((await f.request(base+'/events/'+draft.id,'DELETE',{version:1},f.cookie)).status,401);
    assert.equal((await f.request(base+'/session','POST',{secret:'b'.repeat(43)})).status,200);
    assert.equal((await f.request(base+'/events/'+draft.id,'PATCH',{title:'still mine',startDate:draft.startDate,endDate:draft.endDate,version:1},cookie)).status,200);
    const data=await(await f.request(base)).json();assert.equal(data.events[0].id,draft.id);assert.equal(data.events[0].memberId,f.member.id);
  }finally{await f.mf.dispose();}
});
test('competing rotations have only one winner and never revive an old key',async()=>{
  const f=await fixture();try {
    const base=`/api/calendars/${f.cid}/session`;
    const res=await Promise.all(['c','d'].map(s=>f.request(base,'PATCH',{confirm:true,secret:s.repeat(43)},f.cookie)));
    assert.equal(res.filter(r=>r.status===200).length,1);
    assert.ok(res.every(r=>[200,401,409].includes(r.status)));
    const winner=await res.find(r=>r.status===200).json();
    assert.equal((await f.request(base,'POST',{secret:winner.secret})).status,200);
    assert.equal((await f.request(base,'POST',{secret:'a'.repeat(43)})).status,401);
  }finally{await f.mf.dispose();}
});
