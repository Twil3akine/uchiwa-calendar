#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILD_CONFIG, OUTPUT_CONFIG, makeWorkerName, validateWorkerName, writeCloudflareConfig } from "./cloudflare-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".cloudflare-migration");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const WRANGLER = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");

function parseArgs(args) {
  const options = { help: false, prepare_only: false, confirm_create_if_absent: false, confirm_empty_database: false, confirm_import_complete: false, retry_deploy: false };
  const valued = new Set(["--snapshot", "--account-id", "--record-url", "--deployed-url"]);
  const switches = new Map([
    ["--help", "help"],
    ["--prepare-only", "prepare_only"],
    ["--confirm-create-if-absent", "confirm_create_if_absent"],
    ["--confirm-empty-database", "confirm_empty_database"],
    ["--confirm-import-complete", "confirm_import_complete"],
    ["--retry-deploy", "retry_deploy"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (switches.has(option)) {
      options[switches.get(option)] = true;
      continue;
    }
    if (!valued.has(option)) throw new Error(`Unknown option ${option}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    const key = option.slice(2).replaceAll("-", "_");
    options[key] = value;
    index += 1;
  }
  if (!options.help && !options.snapshot && !options.record_url) throw new Error("Provide --snapshot /absolute/path/to/export.sql.");
  if (options.snapshot) options.snapshot = path.resolve(options.snapshot);
  return options;
}

function run(command, args, { capture = false, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: process.env });
    let out = "";
    let err = "";
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

function parseJson(text, description) {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new Error(`${description} did not return valid JSON. No decision was made from human-readable console output.`);
  }
}

function accountRows(data) {
  if (!data || data.loggedIn !== true || !Array.isArray(data.accounts)) return [];
  return data.accounts.map((account) => ({ id: account?.id ?? account?.account_id, name: account?.name }))
    .filter((account) => typeof account.id === "string" && /^[0-9a-f]{32}$/i.test(account.id));
}

async function ensureAuthenticated() {
  let result = await run(process.execPath, [WRANGLER, "whoami", "--json"], { capture: true });
  let data = null;
  if (result.code === 0) {
    try {
      data = parseJson(result.stdout, "`wrangler whoami --json`");
    } catch {
      data = null;
    }
  }
  if (result.code !== 0 || data?.loggedIn !== true) {
    if (!stdin.isTTY) throw new Error("Wrangler is not authenticated. Run `node node_modules/wrangler/bin/wrangler.js login` in a terminal, then rerun this command.");
    console.log("Wrangler needs a Cloudflare login. Complete its browser sign-in, then the migration will continue.");
    const login = await run(process.execPath, [WRANGLER, "login"]);
    if (login.code !== 0) throw new Error("Wrangler login did not complete. Run `wrangler login` and retry.");
    result = await run(process.execPath, [WRANGLER, "whoami", "--json"], { capture: true });
    if (result.code !== 0) throw new Error("Wrangler still reports no authenticated account. Run `wrangler login` and retry.");
    data = parseJson(result.stdout, "`wrangler whoami --json`");
  }
  if (data?.loggedIn !== true) throw new Error("Wrangler still reports loggedIn=false. Run `wrangler login` and retry.");
  const accounts = accountRows(data);
  if (accounts.length === 0) throw new Error("Wrangler returned no account IDs. Confirm the login can access an account, then rerun.");
  return accounts;
}

function resolveAccount(accounts, requested) {
  if (requested) {
    if (!/^[0-9a-f]{32}$/i.test(requested)) throw new Error("--account-id must be a 32-character Cloudflare account ID.");
    if (!accounts.some((account) => account.id.toLowerCase() === requested.toLowerCase())) {
      throw new Error(`Wrangler login does not list account ${requested}. Choose an account ID shown by wrangler whoami.`);
    }
    return accounts.find((account) => account.id.toLowerCase() === requested.toLowerCase()).id;
  }
  if (accounts.length !== 1) {
    throw new Error(`Wrangler lists ${accounts.length} accounts. Rerun with --account-id <id> to select the intended account.`);
  }
  return accounts[0].id;
}

async function ensureIgnoredStateDirectory() {
  await mkdir(STATE_DIR, { recursive: true });
  const ignore = path.join(STATE_DIR, ".gitignore");
  try {
    await access(ignore);
  } catch {
    await writeFile(ignore, "*\n!.gitignore\n", { mode: 0o600, flag: "wx" }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read migration state at ${STATE_FILE}: ${error.message}`);
  }
}

async function saveState(state) {
  await ensureIgnoredStateDirectory();
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_FILE);
}

async function readSnapshot(snapshotPath) {
  if (!path.isAbsolute(snapshotPath)) throw new Error("Snapshot path must resolve to an absolute path.");
  let bytes;
  try {
    bytes = await readFile(snapshotPath);
  } catch (error) {
    throw new Error(`Cannot read snapshot ${snapshotPath}: ${error.message}`);
  }
  if (!bytes.length) throw new Error("The SQL snapshot is empty.");
  if (!/CREATE\s+TABLE/i.test(bytes.toString("utf8"))) throw new Error("The SQL snapshot contains no CREATE TABLE statement; provide a full D1 export.");
  return { path: snapshotPath, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function randomDatabaseName() {
  return `uchiwa-calendar-${randomBytes(3).toString("hex")}`;
}

function readDatabaseRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.databases)) return data.databases;
  throw new Error("`wrangler d1 list --json` returned an unsupported JSON shape. No database was selected.");
}

function dbName(row) {
  return row?.name ?? row?.database_name;
}

function dbId(row) {
  return row?.uuid ?? row?.database_id ?? row?.id;
}

async function listDatabases(configPath) {
  const result = await run(process.execPath, [WRANGLER, "d1", "list", "--json", "--config", configPath], { capture: true });
  if (result.code !== 0) throw new Error(`Could not list D1 databases. ${result.stderr.trim() || "Check Wrangler access and retry."}`);
  return readDatabaseRows(parseJson(result.stdout, "`wrangler d1 list --json`"));
}

async function createRemoteDatabase(configPath, name) {
  return run(process.execPath, [WRANGLER, "d1", "create", name, "--binding", "DB", "--config", configPath]);
}

async function getTableCount(configPath, databaseName) {
  const command = "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'";
  const result = await run(process.execPath, [WRANGLER, "d1", "execute", databaseName, "--remote", "--command", command, "--json", "--config", configPath], { capture: true });
  if (result.code !== 0) throw new Error(`Could not inspect the new D1 database. ${result.stderr.trim() || "Check the database binding and retry."}`);
  const response = parseJson(result.stdout, "`wrangler d1 execute --json`");
  const blocks = Array.isArray(response) ? response : [response];
  const row = blocks.flatMap((block) => Array.isArray(block?.results) ? block.results : []).find((item) => Object.hasOwn(item ?? {}, "table_count"));
  const count = Number(row?.table_count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Could not read the table count from Wrangler JSON output; stopping before any SQL import.");
  return count;
}

async function importSnapshot(configPath, databaseName, snapshotPath) {
  return run(process.execPath, [WRANGLER, "d1", "execute", databaseName, "--remote", "--file", snapshotPath, "--yes", "--config", configPath]);
}

function validateUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Provide the deployed URL as a full HTTPS URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("The deployed URL must use HTTPS.");
  return parsed.href;
}

async function promptForUrl() {
  if (!stdin.isTTY) return null;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("Paste the HTTPS URL printed by Wrangler (or press Enter to record it later): ");
    return answer.trim() ? validateUrl(answer.trim()) : null;
  } finally {
    rl.close();
  }
}

async function checkLocalPrerequisites(snapshotPath) {
  const snapshot = await readSnapshot(snapshotPath);
  const build = JSON.parse(await readFile(BUILD_CONFIG, "utf8"));
  if (!build.main || !build.assets?.directory) throw new Error("Build output is incomplete. Run the Sites build again.");
  await access(path.resolve(path.dirname(BUILD_CONFIG), build.main));
  await access(path.resolve(path.dirname(BUILD_CONFIG), build.assets.directory));
  await access(path.join(ROOT, "drizzle"));
  await access(WRANGLER);
  return { snapshot, build };
}

async function prepareOnly(options) {
  const { snapshot } = await checkLocalPrerequisites(options.snapshot);
  console.log("Local prerequisites are ready:");
  console.log(`- Worker build config: ${path.relative(ROOT, BUILD_CONFIG)}`);
  console.log(`- SQL snapshot: ${snapshot.path} (${snapshot.bytes} bytes, sha256 ${snapshot.sha256})`);
  console.log("- Wrangler is installed; no account login, Cloudflare API request, D1 creation, import, or deployment was attempted.");
  console.log("Next: run this script without --prepare-only. Wrangler will request login only if needed.");
}

async function ensureDatabase(configPath, state, options) {
  const rows = await listDatabases(configPath);
  if (state.databaseId) {
    const matches = rows.filter((row) => dbName(row) === state.databaseName && String(dbId(row)).toLowerCase() === state.databaseId.toLowerCase());
    if (matches.length !== 1) throw new Error("The D1 database recorded in migration state is not uniquely present in the selected Cloudflare account. Stop and reconcile the state with Wrangler before continuing.");
    return state;
  }

  let matches = rows.filter((row) => dbName(row) === state.databaseName);
  if (state.createStatus === "pending") {
    if (matches.length === 1 && typeof dbId(matches[0]) === "string") {
      state.databaseId = dbId(matches[0]);
      state.createStatus = "created";
      await saveState(state);
      return state;
    }
    if (matches.length > 1) throw new Error(`Multiple D1 databases named ${state.databaseName} exist. Do not create again; manually reconcile the database IDs before rerunning.`);
    if (!options.confirm_create_if_absent) {
      throw new Error(`A D1 create may have completed even though its result was not saved. No matching database is listed now. Verify in Cloudflare, then rerun with --confirm-create-if-absent only after confirming ${state.databaseName} was not created.`);
    }
  } else {
    while (matches.length > 0) {
      state.databaseName = randomDatabaseName();
      matches = rows.filter((row) => dbName(row) === state.databaseName);
    }
  }

  state.createStatus = "pending";
  await saveState(state);
  const created = await createRemoteDatabase(configPath, state.databaseName);
  const after = await listDatabases(configPath);
  matches = after.filter((row) => dbName(row) === state.databaseName);
  if (matches.length === 1 && typeof dbId(matches[0]) === "string") {
    state.databaseId = dbId(matches[0]);
    state.createStatus = "created";
    await saveState(state);
    return state;
  }
  if (created.code !== 0) throw new Error(`D1 creation did not complete visibly. State remains createStatus=pending; do not retry automatically. Reconcile ${state.databaseName} in Wrangler before rerunning.`);
  throw new Error("Wrangler reported D1 creation, but the database ID was not found by `d1 list --json`. State remains pending. Do not create again; rerun after the database becomes visible.");
}

async function deploy(options) {
  if (options.record_url) {
    const state = await readState();
    if (!state || state.deployStatus !== "deployed") throw new Error("No confirmed deployment is recorded yet; --record-url cannot deploy the Worker.");
    state.deployedUrl = validateUrl(options.record_url);
    state.updatedAt = new Date().toISOString();
    await saveState(state);
    console.log(`Recorded deployed URL in ${STATE_FILE}.`);
    return;
  }

  // Verify every local input before prompting for login or creating anything remotely.
  const { snapshot } = await checkLocalPrerequisites(options.snapshot);
  const accounts = await ensureAuthenticated();
  const accountId = resolveAccount(accounts, options.account_id);
  let state = await readState();
  if (state) {
    if (state.accountId !== accountId) throw new Error(`Migration state belongs to account ${state.accountId}. Select that account or move ${STATE_FILE} aside to start a separate migration.`);
    if (state.snapshot?.sha256 !== snapshot.sha256) throw new Error("The SQL snapshot checksum differs from the one recorded in migration state. Use the original snapshot or start a new migration state intentionally.");
  } else {
    state = {
      version: 1,
      accountId,
      workerName: makeWorkerName(),
      databaseName: randomDatabaseName(),
      databaseId: null,
      createStatus: "planned",
      importStatus: null,
      deployStatus: null,
      deployedUrl: null,
      snapshot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveState(state);
  }

  if (!state.workerName) {
    state.workerName = makeWorkerName();
    await saveState(state);
  }
  validateWorkerName(state.workerName);
  if (!/^uchiwa-calendar-[0-9a-f]{24}$/.test(state.workerName)) {
    throw new Error("Migration state has no generated unique Worker name. Create a fresh migration state before deploying.");
  }

  const { outputPath } = await writeCloudflareConfig({ accountId, workerName: state.workerName, sourcePath: BUILD_CONFIG, outputPath: OUTPUT_CONFIG });
  state = await ensureDatabase(outputPath, state, options);
  await writeCloudflareConfig({ accountId, workerName: state.workerName, databaseId: state.databaseId, databaseName: state.databaseName, sourcePath: BUILD_CONFIG, outputPath: OUTPUT_CONFIG });

  if (state.importStatus !== "complete") {
    const tableCount = await getTableCount(OUTPUT_CONFIG, state.databaseName);
    if (state.importStatus === "pending") {
      if (tableCount > 0 && options.confirm_import_complete) {
        state.importStatus = "complete";
        await saveState(state);
      } else if (tableCount === 0 && options.confirm_empty_database) {
        // Explicit confirmation is required after an interrupted import attempt.
      } else {
        throw new Error(tableCount === 0
          ? `An earlier SQL import may have been interrupted. Inspect ${state.databaseName}; if it is empty, rerun with --confirm-empty-database. The snapshot will not be retried automatically.`
          : `The D1 database is populated while import status is pending. Inspect it; if the full snapshot is present, rerun with --confirm-import-complete. It will not be overwritten.`);
      }
    } else if (tableCount !== 0) {
      throw new Error(`The new D1 database already has ${tableCount} user tables. It will not be overwritten or merged. Reconcile this resource before continuing.`);
    }

    if (state.importStatus !== "complete") {
      state.importStatus = "pending";
      await saveState(state);
      const imported = await importSnapshot(OUTPUT_CONFIG, state.databaseName, snapshot.path);
      if (imported.code !== 0) throw new Error(`SQL import did not confirm success. State remains importStatus=pending; inspect the remote database before using --confirm-empty-database or --confirm-import-complete.`);
      state.importStatus = "complete";
      state.updatedAt = new Date().toISOString();
      await saveState(state);
    }
  }

  if (state.deployStatus === "deployed") {
    if (!state.deployedUrl) {
      const deployedUrl = options.deployed_url ? validateUrl(options.deployed_url) : await promptForUrl();
      if (deployedUrl) {
        state.deployedUrl = deployedUrl;
        state.updatedAt = new Date().toISOString();
        await saveState(state);
      }
    }
    console.log(`Deployment is already confirmed. State: ${STATE_FILE}${state.deployedUrl ? `\nURL: ${state.deployedUrl}` : "\nRecord its URL with --record-url <https-url>."}`);
    return;
  }
  if (state.deployStatus === "pending" && !options.retry_deploy) {
    throw new Error("A previous deployment may have completed without saving its result. Inspect the Worker in Cloudflare, then rerun with --retry-deploy if it needs another upload.");
  }

  state.deployStatus = "pending";
  state.updatedAt = new Date().toISOString();
  await saveState(state);
  const deployed = await run(process.execPath, [WRANGLER, "deploy", "--config", OUTPUT_CONFIG]);
  if (deployed.code !== 0) throw new Error("Wrangler deploy did not confirm success. State remains deployStatus=pending; inspect Cloudflare before deciding whether to rerun with --retry-deploy.");
  state.deployStatus = "deployed";
  state.updatedAt = new Date().toISOString();
  await saveState(state);
  state.deployedUrl = options.deployed_url ? validateUrl(options.deployed_url) : await promptForUrl();
  if (state.deployedUrl) {
    state.updatedAt = new Date().toISOString();
    await saveState(state);
    console.log(`Deployment URL recorded: ${state.deployedUrl}`);
  } else {
    console.log(`Deployment confirmed. Paste the HTTPS URL Wrangler printed with --record-url <https-url> to save it in ${STATE_FILE}.`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/cloudflare-deploy.mjs --snapshot /absolute/path/export.sql [--account-id <id>] [options]");
    console.log("       node scripts/cloudflare-deploy.mjs --snapshot /absolute/path/export.sql --prepare-only");
    console.log("       node scripts/cloudflare-deploy.mjs --record-url https://your-worker.workers.dev");
    console.log("Options: --confirm-create-if-absent --confirm-empty-database --confirm-import-complete --retry-deploy --deployed-url <https-url>");
    return;
  }
  if (options.prepare_only) {
    if (!options.snapshot) throw new Error("--prepare-only also requires --snapshot /absolute/path/to/export.sql.");
    await prepareOnly(options);
    return;
  }
  if (options.record_url) {
    await deploy(options);
    return;
  }
  await deploy(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Cloudflare migration: ${error.message}`);
    process.exitCode = 1;
  });
}
