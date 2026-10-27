#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const wranglerRequire = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const esbuild = wranglerRequire('esbuild');

const workerEntry = fileURLToPath(new URL('./api-worker.ts', import.meta.url));
const migrationsPath = new URL('../drizzle/', import.meta.url);
const bundle = await esbuild.build({
  entryPoints: [workerEntry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['cloudflare:workers'],
  write: false,
});

const miniflare = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-05-15',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  ratelimits: {
    CREATE_LIMIT: { namespace_id: '913421', simple: { limit: 5, period: 60 } },
    WRITE_LIMIT: { namespace_id: '913422', simple: { limit: 60, period: 60 } },
    READ_LIMIT: { namespace_id: '913423', simple: { limit: 120, period: 60 } },
  },
}));

const originalFetch = globalThis.fetch;
const originalTestUrl = process.env.CALENDAR_TEST_URL;
const originalArg = process.argv[2];

try {
  const db = await miniflare.getD1Database('DB');
  const migrationFiles = (await readdir(migrationsPath)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  assert.ok(migrationFiles.length >= 1, 'expected D1 migration SQL files');
  for (const [index, file] of migrationFiles.entries()) {
    if (index === 1) {
      await db.prepare("INSERT INTO calendars (id, name) VALUES ('legacy-calendar', 'legacy')").run();
      await db.prepare("INSERT INTO members (member_id, calendar_id, name, secret_hash) VALUES ('legacy-member', 'legacy-calendar', 'legacy', 'legacy-hash')").run();
      await db.prepare("INSERT INTO calendar_events (id, calendar_id, member_id, title, start_date, end_date) VALUES ('legacy-event', 'legacy-calendar', 'legacy-member', 'legacy', '2026-01-01', '2026-01-01')").run();
    }
    const migration = await readFile(new URL(file, migrationsPath), 'utf8');
    const statements = migration.split(/-->\s*statement-breakpoint/g).map((statement) => statement.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
    if (index === 1) {
      const legacy = await db.prepare("SELECT id, repeat_freq, repeat_until, repeat_count FROM calendar_events WHERE id='legacy-event'").first();
      assert.deepEqual(legacy, { id: 'legacy-event', repeat_freq: null, repeat_until: null, repeat_count: null });
    }
  }

  globalThis.fetch = async (input, init) => {
    return miniflare.dispatchFetch(input, init);
  };
  process.env.CALENDAR_TEST_URL = 'http://test.local';
  process.argv[2] = 'http://test.local';

  const integration = await import('./calendar-api.mjs?isolated=1');
  await integration.runPromise;
  console.log('Isolated API integration checks completed through Miniflare and ephemeral D1.');
} catch (error) {
  console.error(`Isolated API integration checks failed: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  if (originalTestUrl === undefined) delete process.env.CALENDAR_TEST_URL;
  else process.env.CALENDAR_TEST_URL = originalTestUrl;
  if (originalArg === undefined) delete process.argv[2];
  else process.argv[2] = originalArg;
  console.log('Disposing ephemeral Miniflare instance…');
  await miniflare.dispose();
  console.log('Ephemeral Miniflare instance disposed.');
}
