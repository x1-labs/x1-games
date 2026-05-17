# `@x1-labs/games-sdk`

Typed TypeScript SDK for building games on **X1 Games** — the settlement layer for wagered play on the X1 blockchain.

This is the only package you need to integrate. It re-exports the protocol schemas from `@x1-labs/games-protocol` and routes calls to whichever backend you select at `connect()` time.

> **Status: v0, mutable.** This SDK targets the v0 integration contract. Breaking changes are expected during v0 development and get sub-version bumps. Integrate against it; don't productionize against it. See [`INTEGRATION.md`](../../INTEGRATION.md) §10.

---

## What this SDK does

| You call... | The platform handles... |
|---|---|
| `platform.registerGame(...)` | Writing the game to the on-chain Game Registry |
| `platform.subscribeMatchStart(...)` | Pushing `MatchStart` events when a wagered match is ready |
| `platform.signAndPostOutcome(...)` | Borsh-encoding, ed25519-signing (for `MANAGED` runtime), and forwarding to the chain `Match` program |

What your game still owns:
- Auth and identity (your existing wallet sign-in works — see Pacman's `siws.ts`)
- The simulator and the rendering
- Match state from receipt of `MatchStart` to call of `signAndPostOutcome`

Nothing else. The SDK absorbs everything between your game and the chain.

---

## Install

```sh
bun add @x1-labs/games-sdk @coral-xyz/anchor @solana/web3.js
# or: npm install @x1-labs/games-sdk @coral-xyz/anchor @solana/web3.js
```

`@coral-xyz/anchor` and `@solana/web3.js` are **peer dependencies** — you install the versions your game pins. This keeps you in control of upgrades (CVE patches reach you without waiting on us) and avoids the `instanceof PublicKey` bugs you get when two copies of `web3.js` end up in the same tree.

Compatible ranges: `@coral-xyz/anchor ^0.32.0`, `@solana/web3.js ^1.95.0`.

---

## 10-line Pacman quickstart

```ts
import { Platform } from "@x1-labs/games-sdk";

const platform = Platform.connect({ network: "stub" });

// 1. Register your game once (idempotent on re-register with same `id`).
const { gameId, attestorPubkey } = await platform.registerGame({
  protocolVersion: "v0",
  id: "pacman",
  displayName: "Pacman",
  tier: "DEMO",
  runtime: "MANAGED",
  attestationModels: ["TRUSTED"],
  seats: { min: 1, max: 4 },
  simulator: { kind: "server", sha256: SIM_HASH },
  devPubkey: DEV_WALLET,
  attestorPubkey: DEV_WALLET, // overwritten by platform for MANAGED
  revenueReceiver: DEV_WALLET,
  joinUrlTemplate: "https://pacman.example.com/play/{matchId}",
  metadataUri: "https://pacman.example.com/metadata.json",
});

// 2. Subscribe to match-start events. The platform invokes this when a
//    wagered match is funded and ready to play.
platform.subscribeMatchStart("pacman", async (start) => {
  // Spin up a room keyed by start.matchId. Seed your RNG with start.seed.
  const room = createPacmanRoom({
    matchId: start.matchId,
    seed: start.seed,
    players: start.players,
    settlementDeadline: start.settlementDeadline,
  });

  // 3. Play the match. When it ends, post the outcome.
  const result = await room.run();

  await platform.signAndPostOutcome({
    matchId: start.matchId,
    gameId: "pacman",
    winners: result.winnerPubkeys,
    payoutShares: result.payoutLamports, // must sum to pot − rake
    replayHash: result.replayHash,        // sha256 of canonical-JSON replay
    idempotencyKey: `pacman-${start.matchId}-outcome`,
  });
});
```

That's the whole integration. Eight calls, three of them owned by your simulator.

---

## How to test it

The `"stub"` network runs the full lifecycle in-memory. You can simulate a player creating a match and joining without any platform infrastructure:

```ts
// In a test, drive the platform side too:
const { matchId } = await platform.createMatch({
  gameId: "pacman",
  seats: 1,
  stakePerSeat: "5000000000",       // 5 XNT
  housePrize: "50000000000",         // 50 XNT
  rakeBps: 300,                       // 3%
  model: "TRUSTED",
  fundingDeadlineSec: 600,
  settlementDeadlineSec: 3600,
});

await platform.joinMatch({ matchId, player: PLAYER_WALLET });
// → your `subscribeMatchStart` handler fires; play out the match;
// → your `signAndPostOutcome` call settles it.

const final = await platform.getMatch(matchId);
console.log(final.state); // "Settled"
```

End-to-end happy path in 6 calls, zero infra. See `tests/stub-flow.test.ts` for a runnable example.

---

## What to wire up on your side

For a solo-vs-house, TRUSTED-attestation game like Pacman, the minimum changes:

1. **Accept an injected seed.** Replace `Date.now() & 0xffffffff` with `MatchStart.seed`. The seed must be the only source of non-determinism for the run.
2. **Externalize the input log.** Your server already records inputs (in SQLite for Pacman); emit a canonical-JSON `Replay` document at match end and hash it with SHA-256. The hash is what you post as `replayHash`.
3. **Add a platform-mode flag.** In wagered mode, skip your existing match-start path (player clicks "play") and instead wait for `subscribeMatchStart`. Free-play and wagered can coexist behind a runtime flag.
4. **Post the outcome.** Hook `room.end()` to call `signAndPostOutcome`. Use an idempotency key that's stable per match so retries are safe.

That's the full integration. Estimated effort: 1–2 dev-days for a game already in the shape Pacman is in.

---

## What you do **not** need to do (yet)

- **No real wallet integration on the server side.** For `MANAGED` runtime, the platform holds the attestor key. Your server signs nothing.
- **No on-chain code.** The SDK never asks you to think about lamports, PDAs, or transaction signing.
- **No payment plumbing.** Players deposit through our flow; you receive `MatchStart` only after stakes have cleared.
- **No challenge-window handling.** TRUSTED attestation has no challenge window. OPTIMISTIC will require you to externalize the replay (you should be doing that anyway), but the dispute path is platform-side.

---

## Caveats and known sharp edges

1. **All four networks are wired.** `stub` runs in-memory; `x1-localnet` defaults to `http://127.0.0.1:8899`; `x1-testnet` and `x1-mainnet` default to `rpc.testnet.x1.xyz` and `rpc.mainnet.x1.xyz` respectively. Override any of them with `opts.rpcUrl`.
2. **The stub is a testing backend.** Stub-mode outcome envelopes are signed with a real ed25519 keypair allocated in memory for that game, but the key is not registered on-chain and disappears when the process exits.
3. **The `OutcomeBody` Borsh layout is pre-v1.** The SDK and chain currently agree on the IDL-driven layout, and `MANAGED` runtime callers should let the SDK serialize it. If you sign outcomes yourself, keep the SDK version pinned with the deployed programs.
4. **Only happy paths are exercised.** Solo-vs-house, PvP/COSIGNED, TRUSTED, and OPTIMISTIC finalize paths have coverage. Async tournaments, ZK attestation, and OPTIMISTIC dispute resolution are spec'd in INTEGRATION.md but not implemented yet.
5. **Schema evolution.** Pre-v1, expect breaking changes. We'll bump `protocolVersion` and call them out in the [`INTEGRATION.md`](../../INTEGRATION.md) changelog.

---

## Reference docs

- [`INTEGRATION.md`](../../INTEGRATION.md) — the v0 contract. The narrative.
- [`@x1-labs/games-protocol`](../games-protocol/) — the schemas. The shape.
- [`WHITEPAPER.md`](../../WHITEPAPER.md) — why the platform looks like this. The reasoning.
- This file — how to wire a game up in 10 minutes. The starting point.

If you're a game dev, read this file first. INTEGRATION.md is the reference you'll come back to.

---

## Reporting issues

Drop them in the x1-games repo. Anything contract-shaped (payload shapes, signing rules, error codes) is treated as breaking-or-not per INTEGRATION.md §10. Anything stub-implementation-shaped (the SDK's stub behavior) is treated as ordinary v0 churn.
