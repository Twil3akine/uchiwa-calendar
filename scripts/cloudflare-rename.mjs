#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILD_CONFIG, OUTPUT_CONFIG, makeCloudflareConfig, validateWorkerName, writeCloudflareConfig } from "./cloudflare-config.mjs";
import { makeCalendarRedirectWorkerSource } from "./calendar-redirect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_FILE = path.join(ROOT, "cloudflare.production.json");
const STATE_DIR = path.join(ROOT, ".cloudflare-migration");
const STATE_FILE = path.join(STATE_DIR, "rename-state.json");
const RENAME_DIR = path.join(STATE_DIR, "rename");
const REDIRECT_CONFIG = path.join(RENAME_DIR, "redirect.wrangler.json");
const SOURCE_CONFIG = path.join(ROOT, "dist/server/cloudflare-rename-source.json");
const TARGET_CONFIG = path.join(ROOT, "dist/server/cloudflare-rename.json");
const WRANGLER = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const BUILD_SCRIPT = path.join(ROOT, "scripts/run-framework.mjs");
const NEW_WORKER_NAME = "uchiwa-calendar";
const ACCOUNT_SUBDOMAIN = "twil3akine";
const TARGET_ORIGIN = `https://${NEW_WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev`;
const EXPECTED_TITLE = "うちわカレンダー";

const STAGES = ["planned", "source_verified", "target_absent", "target_deploy_pending", "target_deployed", "target_verified", "redirect_deploy_pending", "redirect_deployed", "redirected", "production_updated"];

export function parseArgs(args) {
  const options = { commit: false, prepareOnly: false, reconcile: false, retryTarget: false, retryRedirect: false, confirmTargetDeployed: false, help: false };
  for (const arg of args) {
    if (arg === "--commit") options.commit = true;
    else if (arg === "--prepare-only") options.prepareOnly = true;
    else if (arg === "--reconcile") options.reconcile = true;
    else if (arg === "--retry-target") options.retryTarget = true;
    else if (arg === "--retry-redirect") options.retryRedirect = true;
    else if (arg === "--confirm-target-deployed") options.confirmTargetDeployed = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown option ${arg}. Use --help.`);
  }
  if (options.prepareOnly && (options.commit || options.reconcile || options.retryTarget || options.retryRedirect)) {
    throw new Error("--prepare-only cannot be combined with mutation or resume flags.");
  }
  if (options.retryTarget && !options.reconcile) throw new Error("--retry-target requires --reconcile after reviewing an uncertain deployment.");
  if (options.retryRedirect && !options.reconcile) throw new Error("--retry-redirect requires --reconcile after reviewing an uncertain redirect deployment.");
  if (options.confirmTargetDeployed && !options.reconcile) throw new Error("--confirm-target-deployed requires --reconcile after verifying the target Worker version.");
  return options;
}

export function validateProductionSettings(settings) {
  const keys = ["version", "accountId", "workerName", "databaseId", "databaseName", "migrations"];
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || Object.keys(settings).sort().join("|") !== [...keys].sort().join("|")) {
    throw new Error("cloudflare.production.json has an unexpected shape.");
  }
  if (settings.version !== 1 || !/^[0-9a-f]{32}$/i.test(settings.accountId ?? "")) throw new Error("Production settings have an invalid version or account ID.");
  validateWorkerName(settings.workerName);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(settings.databaseId ?? "")) throw new Error("Production settings have an invalid D1 ID.");
  if (typeof settings.databaseName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(settings.databaseName)) throw new Error("Production settings have an invalid D1 database name.");
  if (!Array.isArray(settings.migrations) || !settings.migrations.length) throw new Error("Production settings have no SQL migration fingerprints.");
  let previous = "";
  for (const migration of settings.migrations) {
    if (!migration || Object.keys(migration).sort().join("|") !== "path|sha256" || typeof migration.path !== "string" || !/^drizzle\/[A-Za-z0-9_.-]+\.sql$/.test(migration.path) || migration.path <= previous || !/^[0-9a-f]{64}$/.test(migration.sha256 ?? "")) {
      throw new Error("Production settings contain invalid or unsorted migration fingerprints.");
    }
    previous = migration.path;
  }
  return settings;
}

export function assertMigrationBaseline(settings, currentMigrations) {
  validateProductionSettings(settings);
  if (JSON.stringify(settings.migrations) !== JSON.stringify(currentMigrations)) {
    const expected = new Map(settings.migrations.map(({ path: file, sha256 }) => [file, sha256]));
    const actual = new Map(currentMigrations.map(({ path: file, sha256 }) => [file, sha256]));
    const changed = [...new Set([...expected.keys(), ...actual.keys()])].filter((file) => expected.get(file) !== actual.get(file)).sort();
    throw new Error(`SQL migration baseline changed (${changed.join(", ")}); stop before renaming and use the explicit database migration process.`);
  }
  return settings;
}

export function classifyWorkerLookup(result, { accountId, workerName, missingAllowed = false } = {}) {
  if (result.code === 0) {
    let versions;
    try {
      versions = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Wrangler returned non-JSON output while checking Worker ${workerName}; stopping.`);
    }
    if (!Array.isArray(versions)) throw new Error(`Wrangler returned an unexpected versions list for ${workerName}; stopping.`);
    return { exists: true, versions };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const expectedRoute = `/accounts/${accountId}/workers/scripts/${workerName}/versions`;
  const routeMatches = [...output.matchAll(/\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[A-Za-z0-9_-]+\/versions/g)].map((match) => match[0]);
  const codeMatches = [...output.matchAll(/\[code:\s*(\d+)\]/g)].map((match) => Number(match[1]));
  const absence = codeMatches.length > 0 && codeMatches.every((code) => code === 10007)
    && routeMatches.every((route) => route === expectedRoute)
    && output.includes(expectedRoute);
  if (missingAllowed && absence) return { exists: false, versions: [] };
  if (absence) throw new Error(`The required source Worker ${workerName} was not found in account ${accountId}.`);
  throw new Error(`Wrangler could not verify Worker ${workerName}; the error was not an exact Workers API not-found response. ${output.trim()}`);
}

export function createRedirectResponse(request, newOrigin = TARGET_ORIGIN) {
  const incoming = new URL(request.url);
  if (incoming.pathname === "/api" || incoming.pathname.startsWith("/api/") || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response(JSON.stringify({ error: "このカレンダーは移転しました。新しいURLを開いてください。", url: newOrigin }), {
      status: 409,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const target = `${newOrigin}${incoming.pathname}${incoming.search}`;
  return new Response(null, { status: 307, headers: { Location: target, "Cache-Control": "no-store" } });
}

export function makeRedirectWorkerSource(newOrigin = TARGET_ORIGIN) {
  return makeCalendarRedirectWorkerSource(newOrigin);
}

export function makeRedirectConfig({ accountId, oldWorkerName, compatibilityDate, compatibilityFlags = [] }) {
  validateWorkerName(oldWorkerName);
  if (!/^[0-9a-f]{32}$/i.test(accountId ?? "")) throw new Error("Redirect config requires a valid account ID.");
  if (!compatibilityDate) throw new Error("Redirect config requires a compatibility date from the generated build config.");
  return {
    name: oldWorkerName,
    account_id: accountId,
    main: "redirect.mjs",
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
    no_bundle: true,
    workers_dev: true,
  };
}

export function makeVersionsListArgs({ wranglerPath = WRANGLER, workerName, configPath }) {
  return [wranglerPath, "versions", "list", "--name", workerName, "--json", "--config", configPath];
}

export function makeRenameCloudflareConfig(source, settings, workerName) {
  return makeCloudflareConfig(source, {
    accountId: settings.accountId,
    workerName,
    databaseId: settings.databaseId,
    databaseName: settings.databaseName,
  });
}

export async function fingerprintMigrations(directory = path.join(ROOT, "drizzle")) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).map((entry) => entry.name).sort();
  if (!names.length) throw new Error("No SQL migrations found in drizzle/.");
  const result = [];
  for (const name of names) {
    const bytes = await readFile(path.join(directory, name));
    result.push({ path: `drizzle/${name}`, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return result;
}

async function actualRun(command, args, { cwd = ROOT, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: process.env });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (part) => { stdout += part; });
      child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function loadJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} not found at ${filePath}.`);
    throw new Error(`Cannot read ${label}: ${error.message}`);
  }
}

async function saveJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}

async function ensureIgnoredRenameFiles() {
  await mkdir(RENAME_DIR, { recursive: true });
  const ignorePath = path.join(STATE_DIR, ".gitignore");
  try {
    await access(ignorePath);
  } catch {
    await writeFile(ignorePath, "*\n!.gitignore\n", { flag: "wx", mode: 0o600 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }
}

export async function writeRedirectArtifacts({ accountId, oldWorkerName, compatibilityDate, compatibilityFlags, directory = RENAME_DIR }) {
  await mkdir(directory, { recursive: true });
  const mainPath = path.join(directory, "redirect.mjs");
  const configPath = path.join(directory, "redirect.wrangler.json");
  await writeFile(mainPath, makeRedirectWorkerSource(), { mode: 0o600 });
  const config = makeRedirectConfig({ accountId, oldWorkerName, compatibilityDate, compatibilityFlags });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { mainPath, configPath, config };
}

export async function writeRenameWorkerConfig(settings, workerName, sourcePath = BUILD_CONFIG, outputPath = OUTPUT_CONFIG) {
  return writeCloudflareConfig({
    accountId: settings.accountId,
    workerName,
    databaseId: settings.databaseId,
    databaseName: settings.databaseName,
    sourcePath,
    outputPath,
  });
}

async function writeWorkerConfig(settings, workerName, outputPath) {
  return writeRenameWorkerConfig(settings, workerName, BUILD_CONFIG, outputPath);
}

function stateMatchesSettings(state, settings) {
  return state.accountId === settings.accountId
    && state.databaseId === settings.databaseId
    && state.databaseName === settings.databaseName
    && JSON.stringify(state.migrations) === JSON.stringify(settings.migrations);
}

function createInitialState(settings) {
  return {
    version: 1,
    id: randomUUID(),
    accountId: settings.accountId,
    oldWorkerName: settings.workerName,
    newWorkerName: NEW_WORKER_NAME,
    databaseId: settings.databaseId,
    databaseName: settings.databaseName,
    migrations: settings.migrations,
    remoteStage: "planned",
    targetDeployStatus: null,
    redirectDeployStatus: null,
    updatedAt: new Date().toISOString(),
  };
}

function stateStageAtLeast(state, stage) {
  return STAGES.indexOf(state.remoteStage) >= STAGES.indexOf(stage);
}

async function verifyNewApp(fetcher, origin = TARGET_ORIGIN) {
  const response = await fetcher(origin + "/", { method: "GET", redirect: "manual", cache: "no-store" });
  if (response.status !== 200) throw new Error(`New Worker returned HTTP ${response.status}; the old Worker will not be changed.`);
  const body = await response.text();
  if (!body.includes(EXPECTED_TITLE)) throw new Error("New Worker response does not identify the うちわカレンダー app; the old Worker will not be changed.");
  return true;
}

async function verifyRedirect(fetcher, oldOrigin, newOrigin = TARGET_ORIGIN) {
  const page = await fetcher(`${oldOrigin}/`, { method: "GET", redirect: "manual", cache: "no-store" });
  if (page.status !== 307 || page.headers.get("location") !== `${newOrigin}/`) throw new Error("Old Worker has not confirmed the expected 307 redirect; production settings remain unchanged.");
  const api = await fetcher(`${oldOrigin}/api/`, { method: "GET", redirect: "manual", cache: "no-store" });
  if (api.status !== 409) throw new Error("Old Worker API path did not return 409; production settings remain unchanged.");
  return true;
}

export async function runRenameWorkflow({ settings, options = {}, deps }) {
  validateProductionSettings(settings);
  assertMigrationBaseline(settings, deps.migrations);
  const currentState = await deps.readState();
  let state = currentState;
  if (state) {
    if (!stateMatchesSettings(state, settings)) throw new Error("Saved rename state does not match the selected account, D1, or migration baseline.");
    if (!state.oldWorkerName || !state.newWorkerName || !STAGES.includes(state.remoteStage)) throw new Error("Saved rename state is incomplete; stop and reconcile it before continuing.");
    validateWorkerName(state.oldWorkerName);
    validateWorkerName(state.newWorkerName);
    if (state.newWorkerName !== NEW_WORKER_NAME) throw new Error(`Saved rename state targets ${state.newWorkerName}, not the requested ${NEW_WORKER_NAME}.`);
  } else {
    state = createInitialState(settings);
    await deps.writeState(state);
  }

  const settingsStillOld = settings.workerName === state.oldWorkerName;
  const settingsAlreadyUpdated = settings.workerName === state.newWorkerName && stateStageAtLeast(state, "production_updated");
  const writeWasInterrupted = settings.workerName === state.newWorkerName && state.remoteStage === "redirected";
  if (!settingsStillOld && !settingsAlreadyUpdated && !writeWasInterrupted) throw new Error("Production Worker name changed outside the expected rename flow; stop without touching either Worker.");
  if (writeWasInterrupted) {
    state.remoteStage = "production_updated";
    await deps.writeState(state);
    return state;
  }
  const oldOrigin = deps.oldOriginForWorker ? deps.oldOriginForWorker(state.oldWorkerName) : deps.oldOrigin;

  if (state.remoteStage === "production_updated") return state;

  if (!stateStageAtLeast(state, "source_verified")) {
    const source = await deps.lookupWorker(state.oldWorkerName, SOURCE_CONFIG);
    if (!source.exists || source.versions.length === 0) throw new Error(`Existing Worker ${state.oldWorkerName} did not return a deployed version; no deployment was attempted.`);
    state.remoteStage = "source_verified";
    await deps.writeState(state);
  }

  if (!stateStageAtLeast(state, "target_absent")) {
    const target = await deps.lookupWorker(state.newWorkerName, TARGET_CONFIG, { missingAllowed: true });
    if (target.exists) throw new Error(`Target Worker ${state.newWorkerName} already exists. It will not be overwritten.`);
    state.remoteStage = "target_absent";
    await deps.writeState(state);
  }

  if (state.remoteStage === "target_deploy_pending") {
    if (!options.reconcile) throw new Error("Target deployment result is uncertain. Rerun with --reconcile to inspect the target; it will not be overwritten automatically.");
    const target = await deps.lookupWorker(state.newWorkerName, TARGET_CONFIG, { missingAllowed: true });
    if (target.exists) {
      if (!options.confirmTargetDeployed) throw new Error("Target exists after an uncertain deploy. Inspect its latest version in Wrangler, then rerun with --reconcile --confirm-target-deployed only if this flow created it.");
      await verifyNewApp(deps.fetch, TARGET_ORIGIN);
      state.targetDeployStatus = "confirmed_by_reconcile";
      state.remoteStage = "target_verified";
      await deps.writeState(state);
    } else {
      if (!options.retryTarget) throw new Error("Target is absent, but its prior deploy result was uncertain. Rerun with --reconcile --retry-target to retry after confirming absence.");
      state.remoteStage = "target_absent";
      state.targetDeployStatus = null;
      await deps.writeState(state);
    }
  }

  if (state.remoteStage === "target_absent") {
    const targetBeforeDeploy = await deps.lookupWorker(state.newWorkerName, TARGET_CONFIG, { missingAllowed: true });
    if (targetBeforeDeploy.exists) throw new Error(`Target Worker ${state.newWorkerName} appeared before deployment. It will not be overwritten.`);
    state.remoteStage = "target_deploy_pending";
    state.targetDeployStatus = "pending";
    await deps.writeState(state);
    const result = await deps.deploy(TARGET_CONFIG);
    if (result.code !== 0) throw new Error("New Worker deploy did not confirm success. Old Worker is untouched; rerun with --reconcile.");
    state.remoteStage = "target_deployed";
    state.targetDeployStatus = "deployed";
    await deps.writeState(state);
  }

  if (state.remoteStage === "target_deployed") {
    await verifyNewApp(deps.fetch, TARGET_ORIGIN);
    state.remoteStage = "target_verified";
    await deps.writeState(state);
  }

  if (state.remoteStage === "redirect_deploy_pending" && state.redirectDeployStatus === "pending") {
    if (!options.reconcile) throw new Error("Old Worker redirect result is uncertain. Rerun with --reconcile to inspect it; the production config remains unchanged.");
    try {
      await verifyRedirect(deps.fetch, oldOrigin);
      state.remoteStage = "redirected";
      state.redirectDeployStatus = "deployed";
      await deps.writeState(state);
    } catch (error) {
      if (!options.retryRedirect) throw error;
      state.remoteStage = "target_verified";
      state.redirectDeployStatus = null;
      await deps.writeState(state);
    }
  }

  if (state.remoteStage === "target_verified") {
    state.remoteStage = "redirect_deploy_pending";
    state.redirectDeployStatus = "pending";
    await deps.writeState(state);
    const result = await deps.deploy(REDIRECT_CONFIG);
    if (result.code !== 0) throw new Error("Redirect deploy did not confirm success. The new Worker is verified; production config remains unchanged. Rerun with --reconcile.");
    state.remoteStage = "redirect_deployed";
    state.redirectDeployStatus = "deployed";
    await deps.writeState(state);
  }

  if (state.remoteStage === "redirect_deployed") {
    await verifyRedirect(deps.fetch, oldOrigin);
    state.remoteStage = "redirected";
    await deps.writeState(state);
  }

  if (state.remoteStage === "redirected") {
    const current = await deps.readProduction();
    if (JSON.stringify(current) !== JSON.stringify(settings)) throw new Error("cloudflare.production.json changed during the rename. It was not overwritten; reconcile the file before continuing.");
    const updated = { ...settings, workerName: state.newWorkerName };
    validateProductionSettings(updated);
    await deps.writeProduction(updated);
    state.remoteStage = "production_updated";
    await deps.writeState(state);
  }
  return state;
}

function makeDependencies({ settings, buildSource, oldWorkerName }) {
  return {
    migrations: null,
    oldOriginForWorker: (workerName) => `https://${workerName}.${ACCOUNT_SUBDOMAIN}.workers.dev`,
    async readState() {
      try { return await loadJson(STATE_FILE, "rename state"); }
      catch (error) { if (error.message.startsWith("rename state not found")) return null; throw error; }
    },
    async readProduction() { return validateProductionSettings(await loadJson(PRODUCTION_FILE, "production settings")); },
    writeState(state) { return saveJsonAtomic(STATE_FILE, { ...state, updatedAt: new Date().toISOString() }); },
    async writeProduction(value) { await writeProductionSettings(PRODUCTION_FILE, value); },
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) }),
    async lookupWorker(workerName, configPath, { missingAllowed = false } = {}) {
      const result = await actualRun(process.execPath, makeVersionsListArgs({ workerName, configPath }), { capture: true });
      return classifyWorkerLookup(result, { accountId: settings.accountId, workerName, missingAllowed });
    },
    async deploy(configPath) {
      return actualRun(process.execPath, [WRANGLER, "deploy", "--config", configPath], { capture: false });
    },
    async build() {
      return actualRun(process.execPath, [BUILD_SCRIPT, "build"], { capture: false });
    },
    async writeConfigs() {
      const sourceOutput = await writeWorkerConfig(settings, oldWorkerName ?? settings.workerName, SOURCE_CONFIG);
      const targetOutput = await writeWorkerConfig(settings, NEW_WORKER_NAME, TARGET_CONFIG);
      const redirect = await writeRedirectArtifacts({ accountId: settings.accountId, oldWorkerName: oldWorkerName ?? settings.workerName, compatibilityDate: buildSource.compatibility_date, compatibilityFlags: buildSource.compatibility_flags ?? [] });
      return { sourceOutput, targetOutput, redirect };
    },
    async prepareSource() {
      const source = await loadJson(BUILD_CONFIG, "generated build config");
      buildSource = source;
      return source;
    },
    async git(args) {
      return actualRun("git", args, { capture: true });
    },
  };
}

async function writeProductionSettings(filePath, value) {
  await saveJsonAtomic(filePath, value);
}

async function currentMigrationSettings() {
  const settings = validateProductionSettings(await loadJson(PRODUCTION_FILE, "production settings"));
  const migrations = await fingerprintMigrations();
  assertMigrationBaseline(settings, migrations);
  return { settings, migrations };
}

async function precheckGit(deps, state, productionUpdated) {
  const branch = await deps.git(["branch", "--show-current"]);
  if (branch.code !== 0 || branch.stdout.trim() !== "master") throw new Error("--commit requires the current branch to be master.");
  const status = await deps.git(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (status.code !== 0) throw new Error("Could not inspect Git status before rename.");
  const lines = status.stdout.split("\n").filter(Boolean);
  if (lines.length === 0) return;
  const resumable = productionUpdated && state && lines.every((line) => {
    const xy = line.slice(0, 2);
    const file = line.slice(3);
    return file === "cloudflare.production.json" && [" M", "M ", "MM"].includes(xy);
  });
  if (!resumable) throw new Error("--commit requires a clean tracked worktree and index. Commit or stash tracked changes before starting.");
}

async function commitProductionOnly(deps, state) {
  if (state.gitStage === "complete") return;
  if (state.gitStage === "push_pending") {
    const push = await deps.git(["push", "origin", "master"]);
    if (push.code !== 0) throw new Error("Rename and local commit succeeded, but push failed. Rerun with --commit to retry only `git push origin master`.");
    state.gitStage = "complete";
    await deps.writeState(state);
    return;
  }
  if (state.gitStage !== "commit_pending") {
    state.gitStage = "commit_pending";
    await deps.writeState(state);
  }
  const add = await deps.git(["add", "--", "cloudflare.production.json"]);
  if (add.code !== 0) throw new Error("Could not stage cloudflare.production.json; no other path was staged by this script.");
  const staged = await deps.git(["diff", "--cached", "--name-only"]);
  if (staged.code !== 0 || (staged.stdout.trim() && staged.stdout.trim() !== "cloudflare.production.json")) throw new Error("Refusing to commit because the index contains files other than cloudflare.production.json.");
  if (staged.stdout.trim() === "cloudflare.production.json") {
    const commit = await deps.git(["commit", "-m", "Rename calendar Worker", "--", "cloudflare.production.json"]);
    if (commit.code !== 0) throw new Error("Worker rename completed, but the production settings commit failed. Resolve Git status, then rerun --commit.");
  }
  state.gitStage = "push_pending";
  await deps.writeState(state);
  const push = await deps.git(["push", "origin", "master"]);
  if (push.code !== 0) throw new Error("Worker rename and local commit succeeded, but push failed. Rerun with --commit to retry only `git push origin master`.");
  state.gitStage = "complete";
  await deps.writeState(state);
}

async function ensureBuiltBeforeNetwork(deps) {
  const result = await deps.build();
  if (result.code !== 0) throw new Error(`Project build failed (exit ${result.code}); no Cloudflare request was made.`);
  const source = await deps.prepareSource();
  await access(path.resolve(path.dirname(BUILD_CONFIG), source.main));
  await access(path.resolve(path.dirname(BUILD_CONFIG), source.assets?.directory ?? ""));
  await deps.writeConfigs();
}

export async function prepareRenameOnly({ settings, migrations, buildSource, writeSourceConfig, writeTargetConfig, writeRedirectConfig }) {
  assertMigrationBaseline(settings, migrations);
  if (!buildSource?.main || !buildSource.assets?.directory) throw new Error("Generated build config is incomplete; run the project build first.");
  const sourceConfig = await writeSourceConfig(settings, settings.workerName);
  const targetConfig = await writeTargetConfig(settings, NEW_WORKER_NAME);
  const redirect = await writeRedirectConfig({ accountId: settings.accountId, oldWorkerName: settings.workerName, compatibilityDate: buildSource.compatibility_date, compatibilityFlags: buildSource.compatibility_flags ?? [] });
  return { sourceConfig, targetConfig, redirect };
}

async function prepareOnly(settings, migrations) {
  assertMigrationBaseline(settings, migrations);
  const source = await loadJson(BUILD_CONFIG, "generated build config");
  if (!source.main || !source.assets?.directory) throw new Error("Generated build config is incomplete; run the project build first.");
  await access(path.resolve(path.dirname(BUILD_CONFIG), source.main)).catch(() => { throw new Error("Built Worker entry point is missing; run the build first."); });
  await access(path.resolve(path.dirname(BUILD_CONFIG), source.assets.directory)).catch(() => { throw new Error("Built assets are missing; run the build first."); });
  const prepared = await prepareRenameOnly({
    settings,
    migrations,
    buildSource: source,
    writeSourceConfig: (current, name) => writeWorkerConfig(current, name, SOURCE_CONFIG),
    writeTargetConfig: (current, name) => writeWorkerConfig(current, name, TARGET_CONFIG),
    writeRedirectConfig: writeRedirectArtifacts,
  });
  console.log(`Prepared source config ${prepared.sourceConfig.outputPath}, target config ${prepared.targetConfig.outputPath}, and redirect config ${prepared.redirect.configPath}. No network or deployment was run.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/cloudflare-rename.mjs [--prepare-only | --commit] [--reconcile [--confirm-target-deployed | --retry-target | --retry-redirect]]");
    console.log("--prepare-only validates local state and writes config previews. Default name: uchiwa-calendar.twil3akine.workers.dev.");
    return;
  }
  await ensureIgnoredRenameFiles();
  const { settings, migrations } = await currentMigrationSettings();
  if (options.prepareOnly) return prepareOnly(settings, migrations);
  const state = await loadJson(STATE_FILE, "rename state").catch((error) => error.message.startsWith("rename state not found") ? null : Promise.reject(error));
  if (options.commit) await precheckGit({ git: (args) => actualRun("git", args, { capture: true }) }, state, ["redirected", "production_updated"].includes(state?.remoteStage));
  const deps = makeDependencies({ settings, buildSource: null, oldWorkerName: state?.oldWorkerName ?? settings.workerName });
  deps.migrations = migrations;
  // Build and all local config generation are complete before the first Wrangler/API request.
  if (!stateStageAtLeast(state ?? { remoteStage: "planned" }, "redirected")) await ensureBuiltBeforeNetwork(deps);
  let resultState = await runRenameWorkflow({ settings, options, deps });
  if (options.commit) {
    if (resultState.remoteStage !== "production_updated") throw new Error("Rename did not reach the verified production settings stage; nothing was committed.");
    await commitProductionOnly(deps, resultState);
  }
  console.log(`Rename flow stage: ${resultState.remoteStage}${resultState.gitStage === "complete" ? " (committed and pushed)" : options.commit ? " (commit/push finished)" : "."}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Cloudflare rename: ${error.message}`);
    process.exitCode = 1;
  });
}
