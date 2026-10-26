#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 22.13以上とnpmをインストールしてから実行してください。' >&2
  exit 1
fi

npx --yes pnpm@11.25.0 install --frozen-lockfile
node scripts/run-framework.mjs build
node scripts/cloudflare-deploy.mjs --snapshot migration/source.sql "$@"
