import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertMigrationBaseline,
  classifyWorkerLookup,
  createRedirectResponse,
  makeRedirectConfig,
  makeRenameCloudflareConfig,
  parseArgs,
  prepareRenameOnly,
  runRenameWorkflow,
  validateProductionSettings,
  writeRenameWorkerConfig,
} from "../scripts/cloudflare-rename.mjs";

const migrations = [{ path: "drizzle/0000_lean_omega_red.sql", sha256: "a".repeat(64) }];
const originalSettings = {
  version: 1,
  accountId: "a".repeat(32),
  workerName: "uchiwa-calendar-29d2029c2f86c141788cdeab",
  databaseId: "11ed3a5c-b995-41da-a7e4-6e266b57619a",
  databaseName: "uchiwa-calendar-b812d1",
  migrations,
};
const targetOrigin = "https://uchiwa-calendar.twil3akine.workers.dev";

function createDeps({ targetExists = false, targetStatus = 200, targetBody = "<title>うちわカレンダー</title>", targetDeployCode = 0, redirectDeployCode = 0 } = {}) {
  let state = null;
  let targetDeployed = targetExists;
  let redirectDeployed = false;
  let productionWritten = null;
  const deployCalls = [];
  const deps = {
    migrations,
    oldOriginForWorker: (name) => `https://${name}.twil3akine.workers.dev`,
    async readState() { return state && structuredClone(state); },
    async writeState(next) { state = structuredClone(next); },
    async readProduction() { return structuredClone(originalSettings); },
    async writeProduction(next) { productionWritten = structuredClone(next); },
    async lookupWorker(name) {
      if (name === originalSettings.workerName) return { exists: true, versions: [{ id: "source-version" }] };
      return targetDeployed ? { exists: true, versions: [{ id: "target-version" }] } : { exists: false, versions: [] };
    },
    async deploy(configPath) {
      deployCalls.push(configPath);
      if (configPath.endsWith("cloudflare-rename.json")) {
        if (targetDeployCode !== 0) targetDeployed = true; // Simulate an uncertain result after the request.
        else targetDeployed = true;
        return { code: targetDeployCode };
      }
      if (configPath.endsWith("redirect.wrangler.json")) {
        if (redirectDeployCode === 0) redirectDeployed = true;
        return { code: redirectDeployCode };
      }
      throw new Error(`unexpected deploy config: ${configPath}`);
    },
    async fetch(url, options) {
      const parsed = new URL(url);
      if (parsed.origin === targetOrigin) return new Response(targetBody, { status: targetStatus, headers: { "content-type": "text/html" } });
      if (redirectDeployed) return createRedirectResponse(new Request(url, { method: options.method }), targetOrigin);
      return new Response("old site", { status: 200 });
    },
  };
  return { deps, getState: () => state, deployCalls, getProductionWritten: () => productionWritten };
}

test("validates the deployed production settings and migration baseline", () => {
  assert.equal(validateProductionSettings(originalSettings), originalSettings);
  assert.equal(assertMigrationBaseline(originalSettings, migrations), originalSettings);
  assert.throws(() => assertMigrationBaseline(originalSettings, [{ ...migrations[0], sha256: "b".repeat(64) }]), /explicit database migration process/);
});

test("target collision and ambiguous Wrangler errors stop without deploy", async () => {
  const collision = createDeps({ targetExists: true });
  await assert.rejects(runRenameWorkflow({ settings: originalSettings, deps: collision.deps }), /already exists/);
  assert.deepEqual(collision.deployCalls, []);
  assert.equal(collision.getProductionWritten(), null);

  assert.throws(() => classifyWorkerLookup({ code: 1, stdout: "", stderr: "[code: 10007] failed to read other route" }, {
    accountId: originalSettings.accountId,
    workerName: "uchiwa-calendar",
    missingAllowed: true,
  }), /not an exact Workers API not-found/);
});

test("accepts only exact API not-found codes for target absence", () => {
  const absent = classifyWorkerLookup({
    code: 1,
    stdout: "",
    stderr: `GET /accounts/${originalSettings.accountId}/workers/scripts/uchiwa-calendar/versions [code: 10007] not found`,
  }, { accountId: originalSettings.accountId, workerName: "uchiwa-calendar", missingAllowed: true });
  assert.deepEqual(absent, { exists: false, versions: [] });
  assert.throws(() => classifyWorkerLookup({
    code: 1,
    stdout: "",
    stderr: `GET /accounts/${originalSettings.accountId}/workers/scripts/uchiwa-calendar/versions [code: 10018] unavailable`,
  }, { accountId: originalSettings.accountId, workerName: "uchiwa-calendar", missingAllowed: true }), /not an exact Workers API not-found/);
  assert.throws(() => classifyWorkerLookup({
    code: 1,
    stdout: "",
    stderr: `GET /accounts/${originalSettings.accountId}/workers/scripts/uchiwa-calendar/versions [code: 10090] legacy environment not found`,
  }, { accountId: originalSettings.accountId, workerName: "uchiwa-calendar", missingAllowed: true }), /not an exact Workers API not-found/);
});

test("new Worker deploy or verification failure leaves old Worker and production settings untouched", async () => {
  const deployFailure = createDeps({ targetDeployCode: 1 });
  await assert.rejects(runRenameWorkflow({ settings: originalSettings, deps: deployFailure.deps }), /Old Worker is untouched/);
  assert.equal(deployFailure.deployCalls.some((item) => item.endsWith("redirect.wrangler.json")), false);
  assert.equal(deployFailure.getProductionWritten(), null);

  const verificationFailure = createDeps({ targetStatus: 503 });
  await assert.rejects(runRenameWorkflow({ settings: originalSettings, deps: verificationFailure.deps }), /old Worker will not be changed/);
  assert.equal(verificationFailure.deployCalls.some((item) => item.endsWith("redirect.wrangler.json")), false);
  assert.equal(verificationFailure.getProductionWritten(), null);
});

test("redirect preserves path and query; API and unsafe requests return 409", async () => {
  const page = createRedirectResponse(new Request("https://old.example/calendar/week?month=2027-04", { method: "GET" }), targetOrigin);
  assert.equal(page.status, 307);
  assert.equal(page.headers.get("location"), `${targetOrigin}/calendar/week?month=2027-04`);
  assert.equal(page.headers.get("cache-control"), "no-store");
  for (const request of [
    new Request("https://old.example/api/", { method: "GET" }),
    new Request("https://old.example/calendar", { method: "POST" }),
  ]) {
    const response = createRedirectResponse(request, targetOrigin);
    assert.equal(response.status, 409);
    assert.equal(JSON.parse(await response.text()).url, targetOrigin);
  }
});

test("old and new configs preserve the same D1 binding", () => {
  const source = { main: "index.js", compatibility_date: "2026-05-15", assets: { directory: "../client" } };
  const oldConfig = makeRenameCloudflareConfig(source, originalSettings, originalSettings.workerName);
  const newConfig = makeRenameCloudflareConfig(source, originalSettings, "uchiwa-calendar");
  assert.deepEqual(oldConfig.d1_databases, newConfig.d1_databases);
  assert.equal(newConfig.name, "uchiwa-calendar");
  const redirect = makeRedirectConfig({ accountId: originalSettings.accountId, oldWorkerName: originalSettings.workerName, compatibilityDate: "2026-05-15" });
  assert.equal(Object.hasOwn(redirect, "d1_databases"), false);
});

test("real config writer binds both names to the same existing D1 UUID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "calendar-rename-config-"));
  try {
    const sourcePath = path.join(directory, "wrangler.json");
    await writeFile(sourcePath, JSON.stringify({ main: "index.js", compatibility_date: "2026-05-15", assets: { directory: "../client" } }));
    const oldPath = path.join(directory, "old.json");
    const newPath = path.join(directory, "new.json");
    await writeRenameWorkerConfig(originalSettings, originalSettings.workerName, sourcePath, oldPath);
    await writeRenameWorkerConfig(originalSettings, "uchiwa-calendar", sourcePath, newPath);
    const oldConfig = JSON.parse(await readFile(oldPath, "utf8"));
    const newConfig = JSON.parse(await readFile(newPath, "utf8"));
    assert.deepEqual(oldConfig.d1_databases, newConfig.d1_databases);
    assert.equal(oldConfig.d1_databases[0].database_id, originalSettings.databaseId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production settings change only after the target and old redirect are verified", async () => {
  const run = createDeps({ redirectDeployCode: 1 });
  await assert.rejects(runRenameWorkflow({ settings: originalSettings, deps: run.deps }), /production config remains unchanged/);
  assert.equal(run.getProductionWritten(), null);
});

test("a pending target deployment resumes only through explicit reconciliation", async () => {
  const run = createDeps({ targetDeployCode: 1 });
  await assert.rejects(runRenameWorkflow({ settings: originalSettings, deps: run.deps }), /rerun with --reconcile/);
  const pending = run.getState();
  assert.equal(pending.remoteStage, "target_deploy_pending");
  await assert.rejects(runRenameWorkflow({ settings: originalSettings, options: { reconcile: true }, deps: run.deps }), /confirm-target-deployed/);
  const resumed = await runRenameWorkflow({ settings: originalSettings, options: { reconcile: true, confirmTargetDeployed: true }, deps: run.deps });
  assert.equal(resumed.remoteStage, "production_updated");
  assert.equal(run.getProductionWritten().databaseId, originalSettings.databaseId);
});

test("prepare-only dispatch validates and writes config previews without remote calls", async () => {
  assert.equal(parseArgs(["--prepare-only"]).prepareOnly, true);
  let networkCalls = 0;
  const prepared = await prepareRenameOnly({
    settings: originalSettings,
    migrations,
    buildSource: { main: "index.js", assets: { directory: "../client" }, compatibility_date: "2026-05-15" },
    writeSourceConfig: async (settings, name) => ({ name, databaseId: settings.databaseId }),
    writeTargetConfig: async (settings, name) => ({ name, databaseId: settings.databaseId }),
    writeRedirectConfig: async (input) => ({ oldWorkerName: input.oldWorkerName }),
  });
  assert.equal(networkCalls, 0);
  assert.equal(prepared.targetConfig.databaseId, originalSettings.databaseId);
  assert.equal(prepared.targetConfig.name, "uchiwa-calendar");
});
