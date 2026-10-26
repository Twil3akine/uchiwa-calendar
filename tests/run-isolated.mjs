#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const wranglerRequire = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const esbuild = wranglerRequire('esbuild');

const workerEntry = fileURLToPath(new URL('./api-worker.ts', import.meta.url));
const migrationPath = new URL('../drizzle/0000_lean_omega_red.sql', import.meta.url);
const bundle = await esbuild.build({
  entryPoints: [workerEntry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['cloudflare:workers'],
  write: false,
});

const miniflare = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-05-15',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
});

const originalFetch = globalThis.fetch;
const originalTestUrl = process.env.CALENDAR_TEST_URL;
const originalArg = process.argv[2];

try {
  const db = await miniflare.getD1Database('DB');
  const migration = await readFile(migrationPath, 'utf8');
  const statements = migration.split(/-->\s*statement-breakpoint/g).map((statement) => statement.trim()).filter(Boolean);
  assert.ok(statements.length >= 3, 'expected D1 migration statements');
  await db.batch(statements.map((statement) => db.prepare(statement)));

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
