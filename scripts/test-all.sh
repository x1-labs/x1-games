#!/usr/bin/env bash
# Run the same test matrix CI runs, locally. Stop on the first failure.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== games-protocol ==="
(cd packages/games-protocol && bun test)

echo
echo "=== games-sdk ==="
(cd packages/games-sdk && bun test)

echo
echo "=== services ==="
(cd apps/services && bun test)

echo
echo "=== tic-tac-toe ==="
(cd apps/sample-games/tic-tac-toe && bun test)

echo
echo "=== chain (anchor) ==="
(cd chain && anchor test --skip-build)

echo
echo "ALL GREEN"
