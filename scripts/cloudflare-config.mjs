#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_CONFIG = path.join(ROOT, "dist/server/wrangler.json");
export const OUTPUT_CONFIG = path.join(ROOT, "dist/server/cloudflare.json");
export function makeWorkerName() {
  return `uchiwa-calendar-${randomBytes(12).toString("hex")}`;
}

export function validateWorkerName(workerName) {
  if (typeof workerName !== "string" || workerName.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workerName)) {
    throw new Error("Provide a valid Worker name: 1–63 lowercase letters, digits, and single hyphen separators.");
  }
  return workerName;
}

export function makeCloudflareConfig(source, { accountId, databaseId, databaseName, workerName }) {
  if (!source || typeof source !== "object" || typeof source.main !== "string") {
    throw new Error("The generated Sites build config is missing its Worker entry point. Run the project build first.");
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId ?? "")) throw new Error("Provide a valid Cloudflare account ID with --account-id.");
  if (databaseId && !/^[0-9a-f-]{36}$/i.test(databaseId)) throw new Error("The D1 database ID is invalid.");
  validateWorkerName(workerName);
  const config = {
    name: workerName,
    account_id: accountId,
    main: source.main,
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags ?? [],
    rules: source.rules ?? [],
    no_bundle: source.no_bundle ?? true,
    assets: source.assets,
    jsx_factory: source.jsx_factory,
    jsx_fragment: source.jsx_fragment,
    workers_dev: true,
    observability: source.observability ?? { enabled: true },
    vars: source.vars ?? {},
    d1_databases: databaseId
      ? [{ binding: "DB", database_name: databaseName, database_id: databaseId }]
      : [],
  };
  if (!config.compatibility_date) throw new Error("The generated build config has no compatibility_date. Rebuild the project.");
  if (!config.assets?.directory) throw new Error("The generated build config has no static assets directory. Rebuild the project.");
  return config;
}

export async function writeCloudflareConfig({ accountId, workerName, databaseId, databaseName, sourcePath = BUILD_CONFIG, outputPath = OUTPUT_CONFIG }) {
  let source;
  try {
    source = JSON.parse(await readFile(sourcePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Build config not found at ${sourcePath}. Run the project build first.`);
    throw new Error(`Could not read the generated build config: ${error.message}`);
  }
  const config = makeCloudflareConfig(source, { accountId, workerName, databaseId, databaseName });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { config, outputPath };
}

function readFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--account-id", "--worker-name", "--database-id", "--database-name", "--source", "--output"].includes(flag)) {
      throw new Error(`Unknown option ${flag}.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    result[flag.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const options = readFlags(process.argv.slice(2));
  if (!options.account_id || !options.worker_name) throw new Error("Usage: node scripts/cloudflare-config.mjs --account-id <id> --worker-name <unique-name> [--database-id <id> --database-name <name>]");
  const { outputPath } = await writeCloudflareConfig({
    accountId: options.account_id,
    workerName: options.worker_name,
    databaseId: options.database_id,
    databaseName: options.database_name,
    sourcePath: options.source ? path.resolve(options.source) : BUILD_CONFIG,
    outputPath: options.output ? path.resolve(options.output) : OUTPUT_CONFIG,
  });
  console.log(`Generated ${path.relative(ROOT, outputPath)}. The original generated wrangler.json was left unchanged.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Cloudflare config: ${error.message}`);
    process.exitCode = 1;
  });
}
