# `@x1-labs/sample-tic-tac-toe`

Sample game validating the X1 Games v0 integration contract end-to-end. Also the **reference demo** for running a real wagered match on the platform.

## Layout

| File | Role |
|---|---|
| `src/game.ts` | Pure TTT rules — no dependencies on the platform |
| `src/session.ts` | One-match wrapper binding player pubkeys to X/O symbols |
| `src/server.ts` | `TttGameServer` — drives sessions, settles via SDK |
| `src/main.ts` | Long-running game server (HTTP + WebSocket) — Phase A1 demo |
| `src/cli.ts` | Player CLI — Phase A1 demo |
| `tests/` | Bun tests for layers 1, 2, and 3 (stub end-to-end) |

## Run the playable demo

Prereqs:
- Local validator running (e.g. `surfpool start` or `solana-test-validator`)
- Programs deployed to it (`cd ../../../chain && anchor build && anchor deploy`)

Five terminals (or `tmux`/`zellij` with five panes):

```sh
# 1. Validator
surfpool start

# 2. Build + deploy programs (run once)
cd chain && anchor build && anchor deploy

# 3. TTT game server (this package)
cd apps/sample-games/tic-tac-toe
bun run server
# Prints:
#   [ttt-server] listening on http://127.0.0.1:3002
#   [ttt-server]   gameId:    tic-tac-toe
#   [ttt-server]   attestor:  <pubkey>
#   [ttt-server]   treasury:  <pubkey>

# 4. Player 1
cd apps/sample-games/tic-tac-toe
PLAYER_KEYPAIR=.local/playerA.json bun run play create
# Prints:
#   [ttt-cli] player: <pubkey>
#   [ttt-cli] match created: <matchId>
#   [ttt-cli] tell your opponent:  bun src/cli.ts join <matchId>

# 5. Player 2
cd apps/sample-games/tic-tac-toe
PLAYER_KEYPAIR=.local/playerB.json bun run play join <matchId>
```

Both player CLIs render the board in their terminal. The first player connected sees `[ttt-cli] type a cell number 0-8 to play, or 'q' to quit` and can type a cell index when it's their turn. The other player sees a "← your move" indicator on their turn.

On terminal state (win or draw), the game server posts the outcome to chain via `signAndPostOutcome`. Both clients see a `[ttt-cli] match settled on chain.` message and exit.

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
- ❌ No wallet auth on the WS — players identify themselves by pubkey only (Phase A3 adds SIWS)
- ❌ No web UI — terminal only (Phase A2 adds it)
- ❌ Replay store is process-local — see INTEGRATION.md §3.4.1

## Tests

```sh
bun test           # all three layers, including the stub end-to-end test
```

The chain end-to-end test for TTT lives in `chain/tests/ttt-e2e.spec.ts` and runs inside the anchor harness (`anchor test` in `chain/`).
