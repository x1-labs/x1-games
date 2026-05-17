# X1 Games

Settlement layer for wagered play on the X1 blockchain. Built by **x1-labs**. See [`WHITEPAPER.md`](./WHITEPAPER.md) for design and [`INTEGRATION.md`](./INTEGRATION.md) for the contract game devs build against.

## Layout

```
x1-games/
├── chain/                          # Anchor programs (Match / Game Registry / XP Ledger) + tests
├── packages/
│   ├── games-protocol/             # @x1-labs/games-protocol — schemas, canonical-JSON, replay store
│   └── games-sdk/                  # @x1-labs/games-sdk — typed TS SDK
├── apps/
│   ├── services/                   # @x1-labs/games-services — tRPC API (games, lobbies, xp, replays)
│   └── sample-games/
│       └── tic-tac-toe/            # @x1-labs/sample-tic-tac-toe — reference integration
├── docs/
│   └── platform-backlog.md         # platform services, decentralization split, and roadmap backlog
├── diagrams/                       # architecture & flow diagrams (SVG + PNG)
├── INTEGRATION.md                  # the v0 game integration contract
├── WHITEPAPER.md                   # design rationale
└── scripts/
    ├── test-all.sh                 # local mirror of CI
    ├── smoke-linux.sh              # CI loader smoke under linux+bun (docker)
    └── demo.sh                     # one-command tic-tac-toe demo
```

## One-command demo

```sh
./scripts/demo.sh
```

Starts a local validator, deploys the on-chain programs, brings up the tic-tac-toe game server, and opens a browser. Re-runnable; clean Ctrl-C shutdown. See `apps/sample-games/tic-tac-toe/README.md` for details.

## Toolchain (pinned versions)

| Tool | Version | Install |
|---|---|---|
| **bun** | 1.2.x | https://bun.sh |
| **rust** | stable (host) | https://rustup.rs |
| **Agave (Solana)** | 3.1.14 | `agave-install init v3.1.14` |
| **Anchor CLI** | 1.0.2 | `avm install 1.0.2 && avm use 1.0.2` |
| **surfpool** (validator) | 1.0.0 | `brew tap txtx/taps && brew install surfpool` |

See `memory/reference_toolchain_versions.md` for the upstream-vs-X1 mainnet rationale.

## Test matrix

5 suites, 112 tests total at last check.

| Suite | Cmd (from workspace dir) |
|---|---|
| `@x1-labs/games-protocol` | `bun test` |
| `@x1-labs/games-sdk` | `bun test` |
| `@x1-labs/games-services` | `bun test` |
| `@x1-labs/sample-tic-tac-toe` | `bun test` |
| `chain/` (Anchor) | `anchor test` |

Run them all locally:

```sh
./scripts/test-all.sh
```

## CI

GitHub Actions runs the full matrix on every push and PR to `main` ([`.github/workflows/test.yml`](.github/workflows/test.yml)):

- **`offchain`** job — all four bun-tested workspaces. Fast (<1 min wall).
- **`onchain`** job — installs Agave 3.1.14 + Anchor 1.0.2 + surfpool 1.0, then `anchor build && anchor test`. ~5–15 min depending on cache state.

Caches: Cargo registry/target (`Swatinem/rust-cache`), Agave install dir, avm binaries, surfpool binary. Cold runs take longest; warm runs are dominated by the surfpool validator startup and the OPTIMISTIC test's chain-clock wait.

The two jobs run in parallel — a green PR needs both.

## TDD

Every feature begins with a failing test. The pattern is consistent across the repo: see `chain/tests/*.spec.ts` for on-chain coverage and the `tests/` folders under each TS package for off-chain coverage.
