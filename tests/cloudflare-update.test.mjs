import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  assertMigrationFingerprintsCurrent,
  makeProductionSettingsFromState,
  makeUpdateDeployCommand,
  validateProductionSettings,
} from "../scripts/cloudflare-update.mjs";
import { writeCloudflareConfig } from "../scripts/cloudflare-config.mjs";

const migrations = [{ path: "drizzle/0000_lean_omega_red.sql", sha256: "a".repeat(64) }];
const state = {
  version: 1,
  accountId: "b".repeat(32),
  workerName: "uchiwa-calendar-a1b2c3d4e5f6789012345678",
  databaseId: "12345678-1234-4234-8234-123456789abc",
  databaseName: "uchiwa-calendar-a1b2c3",
  createStatus: "created",
  importStatus: "complete",
  deployStatus: "deployed",
  snapshot: { path: "/private/snapshot.sql", sha256: "secret-data-is-not-copied", bytes: 42 },
};

test("initializes only stable production identifiers and migration hashes", () => {
  const settings = makeProductionSettingsFromState(state, migrations);
  assert.deepEqual(settings, {
    version: 1,
    accountId: state.accountId,
    workerName: state.workerName,
    databaseId: state.databaseId,
    databaseName: state.databaseName,
    migrations,
  });
  assert.equal(Object.hasOwn(settings, "snapshot"), false);
  assert.equal(Object.hasOwn(settings, "secret"), false);
});

test("rejects an incomplete initial migration state", () => {
  assert.throws(() => makeProductionSettingsFromState({ ...state, importStatus: "pending" }, migrations), /completed import/);
});

test("schema changes stop ordinary updates", () => {
  const settings = makeProductionSettingsFromState(state, migrations);
  assert.equal(assertMigrationFingerprintsCurrent(settings, migrations), settings);
  assert.throws(() => assertMigrationFingerprintsCurrent(settings, [{ ...migrations[0], sha256: "c".repeat(64) }]), /explicit database migration process/);
  assert.throws(() => assertMigrationFingerprintsCurrent(settings, [...migrations, { path: "drizzle/0001_more.sql", sha256: "d".repeat(64) }]), /0001_more.sql/);
});

test("writes the existing worker and D1 identifiers into generated config", async () => {
  const settings = makeProductionSettingsFromState(state, migrations);
  const directory = await mkdtemp(path.join(os.tmpdir(), "calendar-update-"));
  try {
    const sourcePath = path.join(directory, "wrangler.json");
    const outputPath = path.join(directory, "cloudflare.json");
    await writeFile(sourcePath, JSON.stringify({
      main: "index.js",
      compatibility_date: "2026-05-15",
      compatibility_flags: ["nodejs_compat"],
      no_bundle: true,
      assets: { directory: "../client" },
    }));
    await writeCloudflareConfig({
      accountId: settings.accountId,
      workerName: settings.workerName,
      databaseId: settings.databaseId,
      databaseName: settings.databaseName,
      sourcePath,
      outputPath,
    });
    const config = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(config.name, settings.workerName);
    assert.equal(config.account_id, settings.accountId);
    assert.deepEqual(config.d1_databases, [{ binding: "DB", database_name: settings.databaseName, database_id: settings.databaseId }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("update command only deploys and cannot run D1 resource commands", () => {
  const command = makeUpdateDeployCommand({ nodePath: "node", wranglerPath: "wrangler.js", configPath: "config.json" });
  assert.deepEqual(command, { command: "node", args: ["wrangler.js", "deploy", "--config", "config.json"] });
  assert.equal(command.args.some((arg) => ["create", "import", "execute", "delete"].includes(arg)), false);
});

test("production settings reject extra credential or snapshot fields", () => {
  const settings = makeProductionSettingsFromState(state, migrations);
  assert.throws(() => validateProductionSettings({ ...settings, token: "not-allowed" }), /only version/);
  assert.throws(() => validateProductionSettings({ ...settings, snapshotPath: "/private/snapshot.sql" }), /only version/);
});

test("accepts a readable Worker name without changing its database", () => {
  const settings = makeProductionSettingsFromState(state, migrations);
  const readable = validateProductionSettings({ ...settings, workerName: "uchiwa-calendar" });
  assert.equal(readable.databaseId, state.databaseId);
  assert.equal(readable.accountId, state.accountId);
  assert.throws(() => validateProductionSettings({ ...settings, workerName: "invalid_name" }), /valid Worker name/);
});

test("CLI initialization and preparation preserve the deployment across a fresh checkout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "calendar-update-cli-"));
  try {
    for (const dir of ["scripts", "drizzle", ".cloudflare-migration", "dist/server", "dist/client"]) {
      await mkdir(path.join(directory, dir), { recursive: true });
    }
    for (const file of ["cloudflare-config.mjs", "cloudflare-update.mjs"]) {
      await writeFile(path.join(directory, "scripts", file), await readFile(new URL(`../scripts/${file}`, import.meta.url)));
    }
    await writeFile(path.join(directory, ".cloudflare-migration/state.json"), JSON.stringify(state));
    await writeFile(path.join(directory, "drizzle/0000_lean_omega_red.sql"), "CREATE TABLE example (id TEXT);\n");
    await writeFile(path.join(directory, "dist/server/index.js"), "export default {};\n");
    await writeFile(path.join(directory, "dist/server/wrangler.json"), JSON.stringify({ main: "index.js", compatibility_date: "2026-05-15", assets: { directory: "../client" } }));
    const run = (flag) => spawnSync(process.execPath, [path.join(directory, "scripts/cloudflare-update.mjs"), flag], { encoding: "utf8", cwd: directory });
    for (const flag of ["--init", "--init", "--prepare-only"]) {
      const result = run(flag);
      assert.equal(result.status, 0, result.stderr);
    }
    const settings = JSON.parse(await readFile(path.join(directory, "cloudflare.production.json"), "utf8"));
    assert.equal(settings.workerName, state.workerName);
    assert.equal(settings.databaseId, state.databaseId);
    await writeFile(path.join(directory, "cloudflare.production.json"), JSON.stringify({ ...settings, workerName: "uchiwa-calendar" }));
    const afterRenameInit = run("--init");
    assert.equal(afterRenameInit.status, 0, afterRenameInit.stderr);
    assert.equal(JSON.parse(await readFile(path.join(directory, "cloudflare.production.json"), "utf8")).workerName, "uchiwa-calendar");
    await rm(path.join(directory, ".cloudflare-migration"), { recursive: true });
    const afterClone = run("--prepare-only");
    assert.equal(afterClone.status, 0, afterClone.stderr);
    const config = JSON.parse(await readFile(path.join(directory, "dist/server/cloudflare.json"), "utf8"));
    assert.equal(config.name, "uchiwa-calendar");
    assert.equal(config.d1_databases[0].database_id, state.databaseId);
    await writeFile(path.join(directory, "drizzle/0001_change.sql"), "ALTER TABLE example ADD COLUMN title TEXT;\n");
    const drift = run("--prepare-only");
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /explicit database migration process/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

