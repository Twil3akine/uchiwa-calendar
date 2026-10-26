#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILD_CONFIG, OUTPUT_CONFIG, writeCloudflareConfig, validateWorkerName } from "./cloudflare-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PRODUCTION_FILE = path.join(ROOT, "cloudflare.production.json");
export const MIGRATION_STATE_FILE = path.join(ROOT, ".cloudflare-migration/state.json");
export const MIGRATION_DIR = path.join(ROOT, "drizzle");
export const BUILD_SCRIPT = path.join(ROOT, "scripts/run-framework.mjs");
export const WRANGLER = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");

export function validateProductionSettings(value) {
  const expectedKeys = ["version", "accountId", "workerName", "databaseId", "databaseName", "migrations"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cloudflare.production.json must contain a JSON object.");
  const keys = Object.keys(value).sort();
  if (keys.join("|") !== [...expectedKeys].sort().join("|")) {
    throw new Error("cloudflare.production.json must contain only version, accountId, workerName, databaseId, databaseName, and migrations.");
  }
  if (value.version !== 1) throw new Error("Unsupported cloudflare.production.json version.");
  if (typeof value.accountId !== "string" || !/^[0-9a-f]{32}$/i.test(value.accountId)) throw new Error("Production accountId must be a 32-character Cloudflare account ID.");
  validateWorkerName(value.workerName);
  if (typeof value.databaseId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.databaseId)) throw new Error("Production databaseId must be a D1 UUID.");
  if (typeof value.databaseName !== "string" || !/^uchiwa-calendar-[0-9a-f]{6}$/.test(value.databaseName)) throw new Error("Production databaseName must match the D1 database created by the migration flow.");
  if (!Array.isArray(value.migrations) || value.migrations.length === 0) throw new Error("Production settings must record at least one SQL migration fingerprint.");
  let previousPath = "";
  for (const migration of value.migrations) {
    if (!migration || typeof migration !== "object" || Object.keys(migration).sort().join("|") !== "path|sha256") {
      throw new Error("Each migration fingerprint must contain only path and sha256.");
    }
    if (typeof migration.path !== "string" || !/^drizzle\/[A-Za-z0-9_.-]+\.sql$/.test(migration.path)) throw new Error("Migration fingerprint path must be a drizzle/*.sql path.");
    if (migration.path <= previousPath) throw new Error("Migration fingerprints must be sorted by path without duplicates.");
    previousPath = migration.path;
    if (typeof migration.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(migration.sha256)) throw new Error(`Invalid SHA-256 fingerprint for ${migration.path}.`);
  }
  return value;
}

export async function fingerprintMigrations(directory = MIGRATION_DIR) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).map((entry) => entry.name).sort();
  if (names.length === 0) throw new Error("No generated SQL migrations were found in drizzle/.");
  const migrations = [];
  for (const name of names) {
    const bytes = await readFile(path.join(directory, name));
    migrations.push({ path: `drizzle/${name}`, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return migrations;
}

export function makeProductionSettingsFromState(state, migrations) {
  if (!state || state.version !== 1) throw new Error("Migration state is missing or unsupported. Run the initial migration first.");
  if (state.createStatus !== "created" || state.importStatus !== "complete" || state.deployStatus !== "deployed") {
    throw new Error("The initial migration must have a created D1 database, completed import, and confirmed deployment before --init.");
  }
  return validateProductionSettings({
    version: 1,
    accountId: state.accountId,
    workerName: state.workerName,
    databaseId: state.databaseId,
    databaseName: state.databaseName,
    migrations,
  });
}

export function assertMigrationFingerprintsCurrent(settings, currentMigrations) {
  validateProductionSettings(settings);
  if (JSON.stringify(settings.migrations) !== JSON.stringify(currentMigrations)) {
    const expected = new Map(settings.migrations.map((item) => [item.path, item.sha256]));
    const actual = new Map(currentMigrations.map((item) => [item.path, item.sha256]));
    const changed = [...new Set([...expected.keys(), ...actual.keys()])]
      .filter((file) => expected.get(file) !== actual.get(file))
      .sort();
    throw new Error(`Generated SQL migration set differs from the applied production baseline: ${changed.join(", ")}. Stop; use the explicit database migration process before deploying schema changes.`);
  }
  return settings;
}

export function makeUpdateDeployCommand({ nodePath = process.execPath, wranglerPath = WRANGLER, configPath = OUTPUT_CONFIG } = {}) {
  return { command: nodePath, args: [wranglerPath, "deploy", "--config", configPath] };
}

export async function loadProductionSettings(filePath = PRODUCTION_FILE) {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Production settings not found. Run `node scripts/cloudflare-update.mjs --init` after the initial migration.");
    throw new Error(`Could not read production settings: ${error.message}`);
  }
  return validateProductionSettings(value);
}

async function readMigrationState(filePath = MIGRATION_STATE_FILE) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Initial migration state was not found. Complete the first Cloudflare migration before running --init.");
    throw new Error(`Could not read migration state: ${error.message}`);
  }
}

async function initializeProductionSettings() {
  const state = await readMigrationState();
  const migrations = await fingerprintMigrations();
  const candidate = makeProductionSettingsFromState(state, migrations);
  try {
    const existing = await loadProductionSettings(PRODUCTION_FILE);
    if (existing.accountId !== candidate.accountId || existing.databaseId !== candidate.databaseId || existing.databaseName !== candidate.databaseName || JSON.stringify(existing.migrations) !== JSON.stringify(candidate.migrations)) {
      throw new Error("cloudflare.production.json already contains different account, D1, or migration settings. It was left unchanged; reconcile settings through the explicit migration process.");
    }
    console.log("Existing production account, D1, migration fingerprints, and current Worker name were preserved; no file changed.");
    return;
  } catch (error) {
    if (!error.message.startsWith("Production settings not found.")) throw error;
  }
  await writeFile(PRODUCTION_FILE, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  console.log("Created cloudflare.production.json with account, Worker, D1 identifiers, and SQL migration fingerprints. No credentials or snapshot path were copied.");
}

async function run(command, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function verifyMigrationBaseline(settings) {
  const migrations = await fingerprintMigrations();
  return assertMigrationFingerprintsCurrent(settings, migrations);
}

async function validateBuiltArtifacts() {
  let source;
  try {
    source = JSON.parse(await readFile(BUILD_CONFIG, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Build output is missing ${path.relative(ROOT, BUILD_CONFIG)}. Run the normal update command to build first, or run node scripts/cloudflare-update.mjs --prepare-only after a build.`);
    throw new Error(`Could not read generated build config: ${error.message}`);
  }
  if (!source.main || !source.assets?.directory) throw new Error("Generated build config is incomplete; rebuild the project before preparing Cloudflare deployment config.");
  await access(path.resolve(path.dirname(BUILD_CONFIG), source.main)).catch(() => {
    throw new Error(`Built Worker entry point ${source.main} is missing; run the project build first.`);
  });
  await access(path.resolve(path.dirname(BUILD_CONFIG), source.assets.directory)).catch(() => {
    throw new Error(`Built assets directory ${source.assets.directory} is missing; run the project build first.`);
  });
  return source;
}

async function prepareDeploymentConfig(settings) {
  await validateBuiltArtifacts();
  return writeCloudflareConfig({
    accountId: settings.accountId,
    workerName: settings.workerName,
    databaseId: settings.databaseId,
    databaseName: settings.databaseName,
    sourcePath: BUILD_CONFIG,
    outputPath: OUTPUT_CONFIG,
  });
}

async function prepareOnly() {
  const settings = await loadProductionSettings();
  await verifyMigrationBaseline(settings);
  const { outputPath, config } = await prepareDeploymentConfig(settings);
  console.log(`Prepared ${path.relative(ROOT, outputPath)} for Worker ${config.name} and existing D1 ${config.d1_databases[0].database_name}. No build, login, network request, or deployment was run.`);
}

async function performUpdate() {
  const settings = await loadProductionSettings();
  await verifyMigrationBaseline(settings);
  console.log("Building the app for Cloudflare...");
  const buildCode = await run(process.execPath, [BUILD_SCRIPT, "build"]);
  if (buildCode !== 0) throw new Error(`Project build failed with exit code ${buildCode}; no deployment was attempted.`);
  await prepareDeploymentConfig(settings);
  const deployCommand = makeUpdateDeployCommand();
  console.log(`Deploying an update to the existing Worker ${settings.workerName}; the existing D1 binding is preserved.`);
  const deployCode = await run(deployCommand.command, deployCommand.args);
  if (deployCode !== 0) throw new Error(`Wrangler deploy failed with exit code ${deployCode}. No D1 create/import/execute/delete command was run.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/cloudflare-update.mjs [--prepare-only | --init]");
    console.log("  --init          Create tracked cloudflare.production.json from completed migration state.");
    console.log("  --prepare-only  Validate schema fingerprints and generate deployment config from an existing build.");
    console.log("  (no flags)      Check schema drift, build, and deploy to the existing Worker/D1.");
    return;
  }
  if (args.length === 1 && args[0] === "--init") return initializeProductionSettings();
  if (args.length === 1 && args[0] === "--prepare-only") return prepareOnly();
  if (args.length > 0) throw new Error(`Unknown options: ${args.join(" ")}. Use --help.`);
  return performUpdate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Cloudflare update: ${error.message}`);
    process.exitCode = 1;
  });
}

