#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const wranglerRequire = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const esbuild = wranglerRequire('esbuild');

const workerEntry = fileURLToPath(new URL('./api-worker.ts', import.meta.url));
const migrationDir = new URL('../drizzle/', import.meta.url);
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
const originalLegacyId = process.env.CALENDAR_TEST_LEGACY_ID;
const originalArg = process.argv[2];

try {
  const db = await miniflare.getD1Database('DB');
  const migrationFiles = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  const statements = (await Promise.all(migrationFiles.map((file) => readFile(new URL(file, migrationDir), 'utf8')))).flatMap((migration) => migration.split(/-->\s*statement-breakpoint/g).map((statement) => statement.trim()).filter(Boolean));
  assert.ok(statements.length >= 3, 'expected D1 migration statements');
  await db.batch(statements.map((statement) => db.prepare(statement)));
  const legacyId = randomUUID();
  await db.prepare('INSERT INTO calendars (id, name, view_key_hash) VALUES (?, ?, NULL)').bind(legacyId, 'Legacy feed compatibility').run();

  globalThis.fetch = async (input, init) => {
    return miniflare.dispatchFetch(input, init);
  };
  process.env.CALENDAR_TEST_URL = 'http://test.local';
  process.env.CALENDAR_TEST_LEGACY_ID = legacyId;
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
  if (originalLegacyId === undefined) delete process.env.CALENDAR_TEST_LEGACY_ID;
  else process.env.CALENDAR_TEST_LEGACY_ID = originalLegacyId;
  if (originalArg === undefined) delete process.argv[2];
  else process.argv[2] = originalArg;
  console.log('Disposing ephemeral Miniflare instance…');
  await miniflare.dispose();
  console.log('Ephemeral Miniflare instance disposed.');
}
