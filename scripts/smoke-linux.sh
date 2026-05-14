#!/usr/bin/env bash
# Quick CI-environment smoke check.
#
# Runs `bun tests/_runner.ts` inside a Linux bun container with the repo
# mounted. Exercises the .ts loader path under the same runtime CI uses,
# without spinning up the full anchor toolchain (which takes 10+ min).
#
# Expected outcome: tests get PAST the loader and fail at runtime with
# `ANCHOR_PROVIDER_URL is not defined` — proves the loader, not the test
# logic. Loader failures (ERR_UNKNOWN_FILE_EXTENSION, default-undefined,
# import-outside-module) all surface here BEFORE we push.

set -euo pipefail
cd "$(dirname "$0")/.."

echo ">> running chain test loader on linux+bun..."
docker run --rm -v "$(pwd)":/repo -w /repo/chain oven/bun:1.2.21 \
  bash -c "bun install --frozen-lockfile --cwd .. >/dev/null && bun tests/_runner.ts" \
  2>&1 | head -20 || true

echo
echo "expected: tests reached runtime and errored on ANCHOR_PROVIDER_URL"
echo "if you see ERR_UNKNOWN_FILE_EXTENSION or a CJS/ESM import error,"
echo "the CI Anchor test step will fail the same way."
