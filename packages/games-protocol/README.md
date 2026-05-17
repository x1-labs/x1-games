# `@x1-labs/games-protocol`

Canonical Zod schemas and shared types for the **X1 Games** integration contract.

This package defines the wire-format primitives that game devs, the SDK, and the platform agree on — `GameRegistration`, `MatchStart`, `OutcomeEnvelope`, replay shapes, and the canonical-JSON encoding used for replay hashing. It also exports a `ReplayStore` interface and an in-memory implementation for tests.

Most game devs don't depend on this package directly — install [`@x1-labs/games-sdk`](https://www.npmjs.com/package/@x1-labs/games-sdk) instead, which re-exports the public types from here.

> **Status: v0, mutable.** This package targets the v0 integration contract. Breaking changes are expected during v0 development and get sub-version bumps. See [`INTEGRATION.md`](https://github.com/x1-labs/x1-games/blob/master/INTEGRATION.md) §10.

## Install

```sh
bun add @x1-labs/games-protocol
# or: npm install @x1-labs/games-protocol
```

## What's in here

| Export | What it is |
|---|---|
| `GameRegistration` | Zod schema for a game's on-chain registration record |
| `MatchStart` | Event payload pushed when a wagered match becomes Live |
| `OutcomeBody` / `OutcomeEnvelope` | Signed settlement payload sent to the chain `Match` program |
| `Replay` | Canonical replay shape (game-specific body + match metadata) |
| `canonicalJSONStringify` | Deterministic JSON encoder used for replay-hash inputs |
| `ReplayStore` | Interface for content-addressed replay storage |
| `getDefaultReplayStore()` | Process-wide in-memory `ReplayStore` (tests, demos) |

All schemas are `zod` objects — call `.parse(...)` for validation, `.shape` for introspection, or `z.infer<typeof Schema>` for the static type.

## License

MIT
