import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeCloudflareConfig, validateWorkerName, writeCloudflareConfig } from "../scripts/cloudflare-config.mjs";

const accountId = "a".repeat(32);
const databaseId = "12345678-1234-4234-8234-123456789abc";
const workerName = "uchiwa-calendar-a1b2c3d4e5f678901234";
const source = {
  name: "site-creator-vinext-starter",
  main: "index.js",
  compatibility_date: "2026-05-15",
  compatibility_flags: ["nodejs_compat"],
  rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  no_bundle: true,
  assets: { directory: "../client" },
  vars: {},
  d1_databases: [{ binding: "DB", database_name: "site-creator-d1", database_id: "00000000-0000-4000-8000-000000000000" }],
};

test("generates a separate deployment config for the selected account and D1", () => {
  const config = makeCloudflareConfig(source, { accountId, workerName, databaseId, databaseName: "uchiwa-calendar-test" });
  assert.equal(config.name, workerName);
  assert.equal(config.account_id, accountId);
  assert.equal(config.d1_databases[0].database_id, databaseId);
  assert.equal(config.d1_databases[0].database_name, "uchiwa-calendar-test");
  assert.equal(config.main, "index.js");
  assert.deepEqual(config.assets, { directory: "../client" });
  assert.equal(source.name, "site-creator-vinext-starter");
  assert.equal(source.d1_databases[0].database_id, "00000000-0000-4000-8000-000000000000");
});

test("can generate an account-scoped config before D1 exists", () => {
  const config = makeCloudflareConfig(source, { accountId, workerName });
  assert.deepEqual(config.d1_databases, []);
  assert.equal(config.workers_dev, true);
});

test("rejects malformed account IDs", () => {
  assert.throws(() => makeCloudflareConfig(source, { accountId: "wrong", workerName }), /valid Cloudflare account ID/);
});

test("validates generated Worker names", () => {
  assert.equal(validateWorkerName(workerName), workerName);
  assert.equal(validateWorkerName("custom-worker-2"), "custom-worker-2");
  assert.throws(() => validateWorkerName("invalid_worker"), /valid Worker name/);
  assert.throws(() => validateWorkerName("Uchiwa Calendar"), /valid Worker name/);
  assert.throws(() => validateWorkerName("x".repeat(64)), /valid Worker name/);
});

test("writes the selected Worker name and D1 through the deployment entry point", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "calendar-config-"));
  try {
    const sourcePath = path.join(directory, "wrangler.json");
    const outputPath = path.join(directory, "cloudflare.json");
    await writeFile(sourcePath, JSON.stringify(source));
    await writeCloudflareConfig({ accountId, workerName, sourcePath, outputPath });
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).name, workerName);
    await writeCloudflareConfig({ accountId, workerName, databaseId, databaseName: "calendar-migration", sourcePath, outputPath });
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(written.name, workerName);
    assert.equal(written.d1_databases[0].database_id, databaseId);
    assert.deepEqual(JSON.parse(await readFile(sourcePath, "utf8")), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
