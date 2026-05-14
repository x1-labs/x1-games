# `@x1-labs/sample-tic-tac-toe`

Sample game validating the X1 Games v0 integration contract end-to-end. Also the **reference demo** for running a real wagered match on the platform.

## Layout

| File | Role |
|---|---|
| `src/game.ts` | Pure TTT rules — no dependencies on the platform |
| `src/session.ts` | One-match wrapper binding player pubkeys to X/O symbols |
| `src/server.ts` | `TttGameServer` — drives sessions, settles via SDK |
| `src/main.ts` | Long-running game server (HTTP + WebSocket) — Phase A1/A2 demo |
| `src/cli.ts` | Player CLI — Phase A1 demo |
| `src/auth.ts` | SIWS-style WS challenge/hello (Phase A3) — shared by all clients |
| `public/index.html` | Web UI shell — Phase A2 demo |
| `public/app.ts` | Browser-side wallet + chain calls + WS client — Phase A2/A3 demo |
| `tests/` | Bun tests for layers 1, 2, and 3 (stub end-to-end) |

## Run the playable demo

### One command

```sh
./scripts/demo.sh
```

Starts surfpool, builds + deploys the three Anchor programs, brings up the TTT server, opens a browser. Press Ctrl-C in the same terminal to shut everything down cleanly. Re-runs are safe — it detects an existing validator and reuses it.

After the script prints the demo URL, open **a second browser window** at the same address. One window clicks **create match**, copies the matchId, the other pastes and clicks **join**. Play through; outcomes settle on chain in real time.

### Manual steps (if you want to inspect each piece)

Prereqs:
- Local validator running (e.g. `surfpool start` or `solana-test-validator`)
- Programs deployed to it (`cd ../../../chain && anchor build && anchor deploy`)

#### Web UI (Phase A2, recommended)

```sh
# 1. Validator
surfpool start

# 2. Build + deploy programs (once)
cd chain && anchor build && anchor deploy

# 3. TTT game server (serves UI at /)
cd apps/sample-games/tic-tac-toe
bun run server
# →  [ttt-server] listening on http://127.0.0.1:3002
```

Open **two browser windows** at `http://127.0.0.1:3002`. Each window:

- Generates an ephemeral wallet (persisted in localStorage) on first load.
- Click **airdrop** to fund it (~1 SOL from the validator faucet).
- Window A clicks **create match**, copies the matchId, sends to window B.
- Window B pastes the matchId, clicks **join**.
- Both see the board. Each clicks cells on their turn.
- On terminal, the game server posts the outcome to chain. Balances update, the status shows win/lose/draw.

Use the **new wallet** button to wipe localStorage and get a fresh keypair (useful for testing both sides of a match in one browser via two profiles).

#### Terminal CLI (Phase A1)

Same server, different players. Open four terminals:

```sh
# 3. TTT game server (same as above)
cd apps/sample-games/tic-tac-toe && bun run server

# 4. Player 1
PLAYER_KEYPAIR=.local/playerA.json bun run play create
# →  [ttt-cli] match created: <matchId>

# 5. Player 2
PLAYER_KEYPAIR=.local/playerB.json bun run play join <matchId>
```

Both CLIs render the board in-terminal. Type a cell number 0–8 to play your turn. Both clients exit cleanly when the server confirms on-chain settlement.

## How the stack composes

```
┌─────────────────┐                      ┌──────────────────┐
│  player CLI A   │  HTTPS/WSS to game   │  player CLI B    │
│  (this package, │  ◄──────────────────►│  (same)          │
│   .local/A.json)│                      │                  │
└────────┬────────┘                      └────────┬─────────┘
         │                                        │
         │  JSON-RPC (signed tx) to chain         │
         │                                        │
         ▼                                        ▼
   ┌─────────────────────────────────────────────────────┐
   │                X1 / Solana validator                │
   │  match_program ◄─► game_registry ◄─► xp_ledger      │
   └────────────────────────────────┬────────────────────┘
                                    │
            outcome ed25519-signed  │
            by the TTT server       │
                                    │
                             ┌──────▼──────────┐
                             │  TTT game server│
                             │  (this package, │
                             │   .local/       │
                             │   attestor.json)│
                             │                 │
                             │  HTTP /info     │
                             │  WS  /play      │
                             └─────────────────┘
```

## What's in v0 / what's not

In v0 (Phase A1):

- ✅ Player CLI talks to chain directly via SDK (uses player keypair)
- ✅ TTT server registers the game on chain at startup
- ✅ Players' stakes escrowed in the chain's Vault PDA on join
- ✅ Game runs server-authoritative — TTT server is the canonical sim
- ✅ Replay uploaded to the in-process replay store, hash committed on-chain
- ✅ Outcome posted by the TTT server's attestor key; payout atomic for TRUSTED
- ✅ Web UI with ephemeral browser wallet (Phase A2)
- ✅ Signed WS auth — server issues a per-connection nonce, client signs `{domain|nonce|timestamp|matchId|player}` with their ed25519 key, server verifies before binding the connection (Phase A3, see `src/auth.ts`)
- ❌ Replay store is process-local — see INTEGRATION.md §3.4.1
- ❌ No real wallet adapter (Phantom, etc.) — the browser stores an ephemeral keypair in localStorage. Production would integrate `@solana/wallet-adapter-*`.

## Tests

```sh
bun test           # all three layers, including the stub end-to-end test
```

The chain end-to-end test for TTT lives in `chain/tests/ttt-e2e.spec.ts` and runs inside the anchor harness (`anchor test` in `chain/`).
