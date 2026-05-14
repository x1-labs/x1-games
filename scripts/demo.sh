#!/usr/bin/env bash
# One-command TTT demo.
#
# Starts a local validator (surfpool), builds and deploys the three Anchor
# programs to it, brings up the tic-tac-toe game server, and opens a browser
# window. Press Ctrl-C to shut everything down cleanly.
#
# Re-run safe: detects an already-running validator on $RPC_PORT and reuses
# it; detects the TTT server port being free; skips re-deploy if program IDs
# already match.
#
# Tools required: surfpool, anchor, solana, bun, curl. Verified at startup.

set -euo pipefail

# -------- config --------------------------------------------------------

RPC_PORT="${RPC_PORT:-8899}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"
TTT_PORT="${TTT_PORT:-3002}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${REPO_ROOT}/.local/demo-logs"
mkdir -p "${LOG_DIR}"

OUR_SURFPOOL_PID=""
OUR_TTT_PID=""

# -------- cleanup -------------------------------------------------------

cleanup() {
  local code=$?
  echo
  echo "[demo] shutting down..."
  if [[ -n "${OUR_TTT_PID}" ]] && kill -0 "${OUR_TTT_PID}" 2>/dev/null; then
    kill -TERM "${OUR_TTT_PID}" 2>/dev/null || true
    wait "${OUR_TTT_PID}" 2>/dev/null || true
  fi
  if [[ -n "${OUR_SURFPOOL_PID}" ]] && kill -0 "${OUR_SURFPOOL_PID}" 2>/dev/null; then
    kill -TERM "${OUR_SURFPOOL_PID}" 2>/dev/null || true
    wait "${OUR_SURFPOOL_PID}" 2>/dev/null || true
  fi
  echo "[demo] done. logs preserved under .local/demo-logs/"
  exit ${code}
}
trap cleanup EXIT INT TERM

# -------- helpers -------------------------------------------------------

require_tool() {
  local tool=$1
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "[demo] missing required tool: ${tool}" >&2
    exit 1
  fi
}

wait_for_url() {
  local url=$1 label=$2 timeout=${3:-30}
  local t=0
  while ! curl -sf -o /dev/null "${url}"; do
    if [[ ${t} -ge ${timeout} ]]; then
      echo "[demo] timeout waiting for ${label} at ${url}" >&2
      return 1
    fi
    sleep 1
    t=$((t + 1))
  done
}

wait_for_rpc() {
  local url=$1 label=$2 timeout=${3:-30}
  local t=0
  while ! curl -sf -o /dev/null -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "${url}"; do
    if [[ ${t} -ge ${timeout} ]]; then
      echo "[demo] timeout waiting for ${label} at ${url}" >&2
      return 1
    fi
    sleep 1
    t=$((t + 1))
  done
}

port_in_use() {
  local port=$1
  # macOS lsof; Linux ss. Both common.
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}\$"
  else
    return 1
  fi
}

open_browser() {
  local url=$1
  if [[ "$(uname)" == "Darwin" ]]; then
    open "${url}" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${url}" >/dev/null 2>&1 &
  fi
}

# -------- preflight -----------------------------------------------------

echo "[demo] checking toolchain..."
require_tool bun
require_tool anchor
require_tool surfpool
require_tool solana
require_tool curl

# Ensure a solana CLI keypair exists for anchor build/deploy.
if [[ ! -f "${HOME}/.config/solana/id.json" ]]; then
  echo "[demo] generating ~/.config/solana/id.json (no passphrase)..."
  mkdir -p "${HOME}/.config/solana"
  solana-keygen new --no-bip39-passphrase --silent \
    --outfile "${HOME}/.config/solana/id.json" >/dev/null
fi

# -------- 1. validator --------------------------------------------------

if curl -sf -o /dev/null -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
     "${RPC_URL}" 2>/dev/null; then
  echo "[demo] validator already running at ${RPC_URL} — reusing"
else
  if port_in_use "${RPC_PORT}"; then
    echo "[demo] port ${RPC_PORT} in use by something that isn't a healthy RPC; abort" >&2
    exit 1
  fi
  echo "[demo] starting surfpool on ${RPC_URL}..."
  surfpool start --no-tui --port "${RPC_PORT}" \
    > "${LOG_DIR}/surfpool.log" 2>&1 &
  OUR_SURFPOOL_PID=$!
  wait_for_rpc "${RPC_URL}" "validator" 30 || {
    echo "[demo] surfpool failed to come up. tail ${LOG_DIR}/surfpool.log:" >&2
    tail -n 30 "${LOG_DIR}/surfpool.log" >&2
    exit 1
  }
  echo "[demo] validator up (pid ${OUR_SURFPOOL_PID})"
fi

# -------- 2. build + deploy --------------------------------------------

echo "[demo] building chain programs..."
(cd "${REPO_ROOT}/chain" && anchor build) > "${LOG_DIR}/anchor-build.log" 2>&1

echo "[demo] deploying programs..."
# anchor deploy reads Anchor.toml [provider].cluster — localnet by default.
(cd "${REPO_ROOT}/chain" && anchor deploy) > "${LOG_DIR}/anchor-deploy.log" 2>&1 || {
  echo "[demo] anchor deploy failed. tail ${LOG_DIR}/anchor-deploy.log:" >&2
  tail -n 30 "${LOG_DIR}/anchor-deploy.log" >&2
  exit 1
}

# Refresh the SDK's bundled IDLs so the browser app + Solana backend see the
# same shape the chain just deployed.
cp "${REPO_ROOT}/chain/target/idl/"*.json \
   "${REPO_ROOT}/packages/games-sdk/src/idl/" 2>/dev/null || true

# -------- 3. TTT server -------------------------------------------------

if port_in_use "${TTT_PORT}"; then
  echo "[demo] port ${TTT_PORT} in use already; assuming TTT server is up"
else
  echo "[demo] starting TTT server on http://127.0.0.1:${TTT_PORT}..."
  (
    cd "${REPO_ROOT}/apps/sample-games/tic-tac-toe"
    RPC_URL="${RPC_URL}" PORT="${TTT_PORT}" bun run src/main.ts
  ) > "${LOG_DIR}/ttt-server.log" 2>&1 &
  OUR_TTT_PID=$!
  wait_for_url "http://127.0.0.1:${TTT_PORT}/info" "TTT server" 30 || {
    echo "[demo] TTT server failed to come up. tail ${LOG_DIR}/ttt-server.log:" >&2
    tail -n 40 "${LOG_DIR}/ttt-server.log" >&2
    exit 1
  }
  echo "[demo] TTT server up (pid ${OUR_TTT_PID})"
fi

# -------- 4. open browser, hold open -----------------------------------

URL="http://127.0.0.1:${TTT_PORT}"
echo
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │  TTT demo ready: ${URL}"
echo "  │"
echo "  │  Open the URL in TWO browser windows (one per player)."
echo "  │  Click 'airdrop' in each, then have one click 'create match'"
echo "  │  and the other paste the matchId and click 'join'."
echo "  │"
echo "  │  Press Ctrl-C in this terminal to shut everything down."
echo "  └─────────────────────────────────────────────────────────────┘"
echo
open_browser "${URL}"

# Hold the script open so trap fires on Ctrl-C.
if [[ -n "${OUR_TTT_PID}" ]]; then
  wait "${OUR_TTT_PID}"
elif [[ -n "${OUR_SURFPOOL_PID}" ]]; then
  wait "${OUR_SURFPOOL_PID}"
else
  echo "[demo] both services were pre-existing; nothing to wait on. Ctrl-C still works to exit."
  while true; do sleep 3600; done
fi
