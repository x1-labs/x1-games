# X1 Games — Integration Contract

*Protocol version: **v0**. Spec date: 2026-05-13. Status: frozen pending v1 — breaking changes bump the version (§10).*

This is the contract between **the X1 Games platform** (operated by x1-labs) and **a game implementation** built on top of it. If something is in this document, you can rely on it. If something is not, it is not yet part of the contract — ask before building against it.

The companion to this document is [`WHITEPAPER.md`](./WHITEPAPER.md), which explains *why* the contract has the shape it does. Read that for context; this doc is the wire-level reference.

---

## 1. Scope and design intent

Three things matter:

1. **Outcomes are signed messages.** A game produces a small signed artifact at the end of a match. The platform forwards it to the chain. The chain pays out. The game does not talk to the chain directly.
2. **Everything is testable against a local stub.** The same SDK that talks to managed/devnet/mainnet also has a `network: "stub"` mode that runs entirely in-process. Game developers should be able to wire their integration end-to-end against the stub before any real platform code is reachable from their machine.
3. **The contract is the surface; the implementation is replaceable.** A game built against this contract works on the managed runtime today and on a self-hosted instance tomorrow (§10 of `WHITEPAPER.md`) without code changes.

What this document does *not* specify:

- The on-chain program layout (see `chain/programs/match/src/lib.rs`).
- The platform's internal services architecture (see `apps/services/`).
- UI, lobby presentation, or any player-facing surface.

---

## 2. Identifiers and primitive types

The TypeScript-flavored type definitions below are normative. Every JSON payload on the wire matches these shapes exactly.

```ts
// 32-byte ed25519 public key, base58-encoded.
// Validates as a 32-byte decoded value. ~43–44 chars.
type Pubkey = string;        // e.g. "9xQeWvG816bUx9EPa2Lh9..."

// 64-byte ed25519 signature, hex-encoded ("0x"-prefixed, lowercase).
type Signature = string;     // e.g. "0xabcd…(128 hex chars)"

// 32-byte digest, hex-encoded ("0x"-prefixed, lowercase).
type Hash = string;          // e.g. "0xabcd…(64 hex chars)"

// Stable per-game string id, registered on-chain. lowercase ASCII, [a-z0-9-], 3–32 chars.
type GameId = string;        // e.g. "pacman"

// On-chain Match PDA address, base58-encoded.
type MatchId = Pubkey;

// XNT amount in lamports (1 XNT = 1e9 lamports). u64 range.
type XntLamports = string;   // string-encoded to preserve precision across JSON; parses as u64

// Unix timestamp in seconds. i64.
type UnixSec = number;

// Random per-request id; UUID v4 or any unique string up to 64 chars.
type IdempotencyKey = string;

// Closed set of attestation models.
type AttestationModel = "TRUSTED" | "COSIGNED" | "OPTIMISTIC" | "ZK";

// Closed set of tiers (see §11 of WHITEPAPER.md).
type Tier = "DEMO" | "LIVE" | "FEATURED";

// Closed set of runtimes.
type Runtime = "MANAGED" | "SELF_HOSTED";
```

**Notes on encoding choices.**

- Pubkeys are base58 to match Solana convention everywhere else in the stack.
- Signatures and hashes are `0x`-prefixed lowercase hex because they have no chain-native string form and hex round-trips cleanly into Rust `[u8; N]`.
- `XntLamports` is a string because JSON numbers lose precision above 2^53 and u64 max exceeds that.

---

## 3. The four payloads

There are four payloads in v0. Everything else is derived from these.

| Payload | Direction | When | Where it lives |
|---|---|---|---|
| **GameRegistration** | game → platform | Once at game registration | On-chain (Game Registry PDA) |
| **MatchStart** | platform → game | At the start of each wagered match | Webhook to the game server |
| **Outcome** | game → platform | At the end of each wagered match | Forwarded to chain Match program |
| **Replay** | game → object store | At the end of each OPTIMISTIC match | Content-addressed off-chain blob |

Each is specified below with a Zod schema (machine-checkable, code-generatable) and a Pacman-flavored example.

### 3.1 GameRegistration

Submitted once when a game is first registered on the platform. Updates re-submit the entire payload signed by `devPubkey`.

```ts
import { z } from "zod";

export const GameRegistration = z.object({
  protocolVersion: z.literal("v0"),

  id: z.string().regex(/^[a-z0-9-]{3,32}$/),
  displayName: z.string().min(1).max(64),

  tier: z.enum(["DEMO", "LIVE", "FEATURED"]),
  runtime: z.enum(["MANAGED", "SELF_HOSTED"]),

  attestationModels: z.array(z.enum(["TRUSTED", "COSIGNED", "OPTIMISTIC", "ZK"])).min(1),

  // What seat counts this game supports. Filtered by §11 tier caps at registration time.
  seats: z.object({
    min: z.number().int().min(1).max(16),
    max: z.number().int().min(1).max(16),
  }).refine((s) => s.max >= s.min, "seats.max must be >= seats.min"),

  // Simulator commitment — what `replayHash` must be reproducible against.
  simulator: z.object({
    kind: z.enum(["wasm", "server"]),
    uri: z.string().url().optional(),   // ipfs:// or https:// for wasm kind
    sha256: z.string().regex(/^0x[0-9a-f]{64}$/),
  }),

  devPubkey: z.string(),       // principal; authorizes updates and bond control
  attestorPubkey: z.string(),  // signs outcomes; may equal devPubkey for self-hosted
  revenueReceiver: z.string(), // dev-side rake destination

  // Where the platform can push MatchStart webhooks for this game.
  // Only required for SELF_HOSTED runtime; MANAGED games may omit (we orchestrate in-process).
  webhookUrl: z.string().url().optional(),

  // Where players are sent after match creation. Templated with {matchId}.
  joinUrlTemplate: z.string(),  // e.g. "https://pacman.example.com/play/{matchId}"

  metadataUri: z.string().url(),  // off-chain JSON: description, screenshots, links
});
export type GameRegistration = z.infer<typeof GameRegistration>;
```

**Pacman example.**

```json
{
  "protocolVersion": "v0",
  "id": "pacman",
  "displayName": "Pacman",
  "tier": "DEMO",
  "runtime": "MANAGED",
  "attestationModels": ["TRUSTED", "OPTIMISTIC"],
  "seats": { "min": 1, "max": 4 },
  "simulator": {
    "kind": "server",
    "sha256": "0x4f9b…(64 hex)"
  },
  "devPubkey": "9xQeWvG816bUx9EPa2Lh9KqW…",
  "attestorPubkey": "9xQeWvG816bUx9EPa2Lh9KqW…",
  "revenueReceiver": "9xQeWvG816bUx9EPa2Lh9KqW…",
  "joinUrlTemplate": "https://pacman.x1-labs.dev/play/{matchId}",
  "metadataUri": "ipfs://bafy…/pacman.json"
}
```

For MANAGED runtime, `attestorPubkey` is allocated by the platform on registration and returned in the response; the game dev never sees the private key (§10.1 of WHITEPAPER.md).

### 3.2 MatchStart

Pushed from the platform to the game server when a new wagered match has been created on-chain and is ready to play. Delivered via signed webhook (§5.1) for SELF_HOSTED games; delivered in-process for MANAGED games via the same payload shape.

```ts
export const MatchStart = z.object({
  protocolVersion: z.literal("v0"),

  matchId: z.string(),              // on-chain Match PDA
  gameId: z.string(),
  seed: z.string().regex(/^0x[0-9a-f]{16}$/),  // 8-byte random seed, hex; deterministic input to the sim
  seats: z.number().int().min(1).max(16),
  stakePerSeat: z.string(),         // XntLamports
  housePrize: z.string().nullable(), // XntLamports for solo-vs-house, else null
  rakeBps: z.number().int().min(0).max(1000),
  model: z.enum(["TRUSTED", "COSIGNED", "OPTIMISTIC", "ZK"]),

  // Wallet pubkeys of players who have funded their seats.
  // Order is the order they joined; same order as on-chain `match.players`.
  players: z.array(z.string()).min(1),

  // Who is allowed to sign the outcome. For MANAGED, this is the platform-held key
  // and the game asks the platform's signer service to sign (§5.3).
  attestorPubkey: z.string(),

  fundingDeadline: z.number().int(),
  settlementDeadline: z.number().int(),

  // Where the game must POST the outcome.
  outcomeEndpoint: z.string().url(),

  // Where the game must PUT the replay (OPTIMISTIC games only; null otherwise).
  // The platform issues a pre-signed URL bound to {matchId}.
  replayUploadUrl: z.string().url().nullable(),
});
export type MatchStart = z.infer<typeof MatchStart>;
```

**Pacman example (solo, OPTIMISTIC).**

```json
{
  "protocolVersion": "v0",
  "matchId": "Br9c…",
  "gameId": "pacman",
  "seed": "0x7a3f2c91d4e08b15",
  "seats": 1,
  "stakePerSeat": "5000000000",
  "housePrize": "50000000000",
  "rakeBps": 300,
  "model": "OPTIMISTIC",
  "players": ["9xQe…"],
  "attestorPubkey": "Att…",
  "fundingDeadline": 1747136400,
  "settlementDeadline": 1747140000,
  "outcomeEndpoint": "https://api.x1-labs.dev/v0/games/pacman/matches/Br9c…/outcome",
  "replayUploadUrl": "https://replays.x1-labs.dev/...?signed=…"
}
```

The game MUST use `seed` as the canonical source of randomness for this match. Any non-deterministic source (current time, system entropy) breaks OPTIMISTIC re-simulation and the match becomes unsettleable on dispute.

### 3.3 Outcome

Produced by the game at match end and POSTed to `outcomeEndpoint` from §3.2. The platform forwards it to the chain Match program's `post_outcome` instruction.

The Outcome is signed in **its Borsh encoding** (§4) — not in its JSON encoding — because the chain re-verifies the signature against the Borsh bytes.

```ts
export const OutcomeBody = z.object({
  matchId: z.string(),
  winners: z.array(z.string()).min(1).max(16),
  payoutShares: z.array(z.string()).min(1).max(16),  // XntLamports each, sums to pot − rake
  replayHash: z.string().regex(/^0x[0-9a-f]{64}$/),  // sha256 of canonical replay JSON; zero if no replay
  postedAt: z.number().int(),                         // unix sec, server time
  attestor: z.string(),                               // pubkey that produced this outcome
}).refine((o) => o.winners.length === o.payoutShares.length, "winners.length must equal payoutShares.length");

export const OutcomeEnvelope = z.object({
  protocolVersion: z.literal("v0"),
  outcome: OutcomeBody,
  borsh: z.string().regex(/^0x[0-9a-f]+$/),  // borsh-encoded OutcomeBody, hex
  signature: z.string().regex(/^0x[0-9a-f]{128}$/),  // ed25519 over `borsh` bytes
  idempotencyKey: z.string().max(64),
});
export type Outcome = z.infer<typeof OutcomeBody>;
```

Borsh schema for `OutcomeBody` (matches the Rust struct posted to the Match program):

```
OutcomeBody {
  match_id:        [u8; 32],
  winners:         Vec<[u8; 32]>,    // u32 length prefix per Borsh
  payout_shares:   Vec<u64>,
  replay_hash:     [u8; 32],
  posted_at:       i64,
  attestor:        [u8; 32],
}
```

**Pacman example (solo player won).**

```json
{
  "protocolVersion": "v0",
  "outcome": {
    "matchId": "Br9c…",
    "winners": ["9xQe…"],
    "payoutShares": ["53350000000"],
    "replayHash": "0xa1b2c3…",
    "postedAt": 1747136580,
    "attestor": "Att…"
  },
  "borsh": "0x….",
  "signature": "0x….",
  "idempotencyKey": "pacman-Br9c-outcome-1"
}
```

### 3.4 Replay

JSON document describing every input fed to the simulator, plus the canonical seed. Stored off-chain at `replayUploadUrl` from §3.2; its SHA-256 is committed in `replayHash` (§3.3).

```ts
export const Replay = z.object({
  protocolVersion: z.literal("v0"),

  matchId: z.string(),
  gameId: z.string(),
  simulatorSha256: z.string().regex(/^0x[0-9a-f]{64}$/),  // must match Game Registry simulator hash
  seed: z.string().regex(/^0x[0-9a-f]{16}$/),

  initialState: z.unknown(),   // game-specific; for Pacman: maze + starting positions + lives
  finalState: z.unknown(),     // game-specific; must include the score that yielded payoutShares

  // Ordered input stream. Game-specific input shape under `data`.
  // tick order is ascending; ties resolved by index within the tick.
  inputs: z.array(z.object({
    tick: z.number().int().min(0),
    playerIndex: z.number().int().min(0),  // index into MatchStart.players
    data: z.unknown(),
  })),

  startedAt: z.number().int(),
  endedAt: z.number().int(),
});
export type Replay = z.infer<typeof Replay>;
```

The replay file MUST be encoded as **canonical JSON** — UTF-8, sorted object keys, no insignificant whitespace, no trailing newline — and the file's SHA-256 is what gets committed on-chain. Two implementations producing the same Replay object MUST produce byte-identical files.

> **v0 canonicalization.** `@x1-labs/games-protocol` ships a `canonicalJson(value)` helper that sorts object keys recursively and emits `JSON.stringify` output with no whitespace. This is the "good-enough" subset; production replays will move to a full RFC 8785 (JSON Canonicalization Scheme) implementation to handle Unicode normalization and number-formatting corner cases. The function signature won't change; bytes for ASCII-only payloads already match.

For OPTIMISTIC matches, the game MUST upload the replay BEFORE posting the Outcome. Posting an outcome whose `replayHash` cannot be fetched is grounds for dispute (and slashing under Live tier).

#### 3.4.1 v0 storage API

For v0, the platform provides a process-local replay store reachable two ways:

- **From the SDK:** `await platform.uploadReplay({ replay })` returns `{ matchId, replayHash, bytes }`. Symmetrically, `await platform.getReplay({ matchId })` returns the stored body. Same handles for `network: "stub"` and `network: "x1-localnet"` — both back onto the in-memory store from `@x1-labs/games-protocol` shipped in the same process.
- **From the public API:** `replays.put({ replay })` and `replays.get({ matchId })` tRPC procedures on the services tier. Same shape, same store.

Constraints enforced by `put`:

- Replay is schema-validated (§3.4 schema) before storage.
- A second `put` for the same `matchId` is **idempotent if and only if the canonical body is byte-identical**. A second put with a different body is rejected (`Conflict`).
- Max body size: 5 MiB (configurable per deployment).

`get` returns `{ matchId, replayHash, replay, bytes }`. The caller verifies the hash by recomputing `canonicalSha256(replay)`.

The hash committed on-chain via `OutcomeBody.replayHash` is exactly the value returned by `uploadReplay`. The on-chain Match program never stores or verifies the body — it only stores the hash. Verification is delegated to whoever chooses to challenge during the OPTIMISTIC window.

> **v0 limitation: process-local storage.** The replay store is in-process, in-memory. Persistence across restarts and reachability across machines are *not* in v0. Production storage will be content-addressed object storage (S3-style) behind pre-signed URLs in the Replay upload flow already specified by `MatchStart.replayUploadUrl`. The SDK and tRPC surface above are the contract that will not change.

---

## 4. Signing and canonical encoding

### 4.1 What gets signed

The 64-byte ed25519 signature in `OutcomeEnvelope.signature` is over the **Borsh-encoded `OutcomeBody`** bytes (not its JSON form, not any wrapper, not a domain-separation prefix in v0).

```
signature = ed25519_sign(attestor_private_key, borsh_bytes_of_OutcomeBody)
```

The chain Match program re-encodes the OutcomeBody it receives (Anchor decodes the instruction args), then calls `ed25519_verify(attestor, signature, re_encoded_borsh_bytes)`. If they match, the outcome is accepted.

**Why Borsh, not canonical JSON.** The chain has a Borsh syscall and can verify natively. Canonical JSON would require shipping a JSON canonicalizer into the program. Off-chain code in the SDK serializes once and ships the bytes.

### 4.2 What gets hashed

`replayHash` is SHA-256 over the canonical-JSON-encoded `Replay` file (§3.4):

```
replayHash = sha256(canonical_json(Replay))
```

Anyone with the replay file can recompute the hash and compare. This is the heart of OPTIMISTIC dispute (§6.3 of WHITEPAPER.md).

### 4.3 What the chain does not verify

The chain does not verify the replay contents — it only stores the hash. Validity of the replay (does it re-simulate to the posted outcome?) is enforced by **anyone who chooses to challenge during the challenge window**. The economic game is that running a fraudulent OPTIMISTIC outcome is only profitable if you also count on no one re-simulating; the slashable Live-tier bond (§11.3) makes the math obvious.

---

## 5. Transport and authentication

### 5.1 Webhooks (platform → game)

For SELF_HOSTED runtime, the platform delivers MatchStart payloads as HTTPS POSTs to the game's registered `webhookUrl` (§3.1). Every webhook carries:

```
POST {webhookUrl}
Content-Type: application/json
X-X1Games-Signature: 0x... (ed25519 over the request body, by platform key)
X-X1Games-Pubkey:    <platform pubkey, base58>
X-X1Games-Timestamp: <unix sec>
X-X1Games-Event:     match.start
X-X1Games-Idempotency-Key: <stable per-event id>
```

The game MUST:
1. Verify `signature` against `body` using the platform's pubkey (pinned at registration).
2. Reject if `|now − timestamp| > 300` seconds.
3. Treat any retry with the same `idempotency-key` as a no-op after the first success.

The platform retries failed webhooks with exponential backoff for up to 24 hours (capped). Persistent failure surfaces as a tier-relevant signal — Featured games are expected to maintain webhook delivery.

For MANAGED runtime, no webhook is needed; the platform calls the game's in-process handler directly via the same payload shape.

### 5.2 Game → platform calls

Game-side calls go to the public API (§9 of WHITEPAPER.md), authenticated with the game's `devPubkey` or `attestorPubkey` as appropriate:

| Endpoint | Auth key | Notes |
|---|---|---|
| `POST /v0/games` | `devPubkey` | GameRegistration submit/update |
| `POST /v0/games/{gameId}/matches/{matchId}/outcome` | `attestorPubkey` | OutcomeEnvelope submit |

Authentication: every request carries a `X1Games-Auth` header of the form `<pubkey>:<signature-over-(method+path+body-sha256+timestamp)>`. The platform re-signs and verifies the same way games verify webhooks.

### 5.3 Attestor key management

For SELF_HOSTED games, the `attestorPubkey` is whatever key the game dev chooses — typically the game server's signing key, stored locally.

For MANAGED games, the platform holds the attestor private key in an HSM-backed enclave. The game does not sign outcomes itself; it submits an *unsigned* OutcomeBody to a platform-internal signer endpoint, the platform signs in-place, and the resulting OutcomeEnvelope is forwarded to the chain. The game still receives the signed envelope so it can store / replay it.

```
// MANAGED-runtime alternative to §3.3:
POST /v0/games/{gameId}/matches/{matchId}/outcome/sign-and-post
Body: { outcome: OutcomeBody, idempotencyKey: string }
Returns: { envelope: OutcomeEnvelope, chainSignature: string }
```

### 5.4 The stub network

For local development, the SDK exposes `network: "stub"`. In stub mode all payloads round-trip in-memory. Outcome envelopes are signed with a real ed25519 keypair allocated in memory for that registered game, and replay storage uses the process-local in-memory replay store. The same Zod schemas validate every payload, so a stub-passing integration passes contract validation when pointed at localnet/testnet/mainnet.

---

## 6. Error model

Every API response is either a success body or an error envelope. Errors are a discriminated union; clients MUST branch on `code`, never parse `message`.

```ts
export const ErrorCode = z.enum([
  // 4xx
  "BadRequest",
  "Unauthorized",
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "InvalidSignature",
  "AttestorMismatch",
  "MatchNotInState",
  "InsufficientFunds",
  "TierForbidden",
  "ProtocolVersionMismatch",

  // 5xx
  "InternalError",
  "ChainUnavailable",
  "ManagedSignerUnavailable",
]);

export const ErrorEnvelope = z.object({
  protocolVersion: z.literal("v0"),
  code: ErrorCode,
  message: z.string(),         // human-readable; agents IGNORE this
  detail: z.record(z.unknown()).optional(),
  retryable: z.boolean(),      // safe to retry as-is?
  requestId: z.string(),       // for support correlation
});
```

The same shape applies to webhook delivery responses from the game back to the platform.

---

## 7. State alignment between game and chain

The chain Match state (§5.1 of WHITEPAPER.md) and the game's view of a match must stay aligned at well-defined moments:

| Chain state | Game-side meaning | Triggered by |
|---|---|---|
| `Created` | Game has not been informed yet. | `create_match` instruction |
| `Funded` | Some players have joined, match not full. Game has been informed via MatchStart but should not start play. | `join_match` (first n−1 joins) |
| `Live` | All seats filled. Game starts play. | `join_match` (final seat) — this is when the platform pushes MatchStart for solo or the "play now" signal for PvP |
| `Settled` | Outcome posted, awaiting finalization. | Game posted OutcomeEnvelope |
| `Paid` | Payouts disbursed. | `finalize_match` after challenge window (or immediately for TRUSTED/COSIGNED) |
| `Expired` | Funding deadline passed, players refunded. | Time |
| `Disputed` / `Resolved` | OPTIMISTIC dispute path (§6.3 of WHITEPAPER.md). | Challenger / program |

The game is expected to track at most two of these locally: it knows the match is **Live** when it receives MatchStart, and it considers the match **Settled** once it has POSTed a successful OutcomeEnvelope and received a non-error response. Chain-side `Paid`/`Disputed` outcomes are platform concerns; the game does not need to act on them in v0.

---

## 8. Worked example: Pacman, solo, OPTIMISTIC

End-to-end for a single solo Pacman match. All payloads abbreviated for readability.

**Step 1 — Registration (once).**

Pacman dev runs `bunx x1-games register-game` (or the SDK equivalent), submitting a GameRegistration (§3.1). The platform writes to the Game Registry on-chain, allocates a MANAGED attestor key, and returns the allocated `attestorPubkey`.

**Step 2 — Player creates a match.**

Player visits `pacman.x1-labs.dev`, signs in with their wallet, and clicks "Wager 5 XNT". The Pacman frontend calls our public API:

```
POST /v0/lobbies
{
  "gameId": "pacman",
  "seats": 1,
  "stakePerSeat": "5000000000",
  "housePrize": "50000000000",
  "model": "OPTIMISTIC"
}
```

The platform creates the on-chain Match (calls `create_match`), waits for the player's deposit, and on `state == Live` issues MatchStart (§3.2) to Pacman.

**Step 3 — Pacman runs the game.**

Pacman receives MatchStart, creates a room keyed by `matchId`, seeds its RNG with `seed`, and waits for the player's WebSocket connection at `joinUrlTemplate.replace("{matchId}", matchId)`. Player plays; Pacman ticks the canonical simulator.

**Step 4 — Match ends.**

Pacman finalizes the score. If the player exceeded the win threshold, `winners = [playerPubkey]` and `payoutShares = [pot − rake]`. Otherwise `winners = [housePubkey]` and the prize returns to the treasury.

Pacman writes the canonical Replay (§3.4) to `replayUploadUrl`, computes `replayHash = sha256(canonicalJson(replay))`, builds the OutcomeBody, and POSTs the OutcomeEnvelope (§3.3) to `outcomeEndpoint`. Because Pacman is MANAGED in this example, it actually uses the `sign-and-post` variant (§5.3) — the platform signs.

**Step 5 — Settlement.**

Platform forwards the signed envelope to the chain Match program. Chain stores the outcome, opens the 1-hour OPTIMISTIC challenge window. After the window with no challenge, `finalize_match` runs, pot pays out, rake to treasury, XP credit.

Pacman's job is done after Step 4. Steps 5+ are platform concerns.

---

## 9. Schemas as code

The Zod schemas in §3 and §6 are the canonical machine-checkable form of this document. They ship as the `@x1-labs/games-protocol` package (pending implementation in `packages/games-protocol/`); JSON Schema can be generated from them via `zod-to-json-schema` for Python, Rust, or any other consumer.

When the schemas land in code, this document remains authoritative for the *narrative* (what the payload means, when it flows, who signs it); the schemas are authoritative for the *shape* (which fields, what types). Any divergence is a bug in the schemas, not in the doc.

---

## 10. Evolution and breaking changes

This contract is at **v0**, meaning:

- We expect to break it during v0 development. Breaking changes here are versioned (`v0.1`, `v0.2`, …) and called out in the changelog at the bottom of this file.
- Pre-v1, no compatibility guarantees. The stub SDK and devnet may run different sub-versions simultaneously; the schemas tell you which.
- At v1, the contract freezes for compatibility: any breaking change goes to v2 with overlapping support during a deprecation window.

**Breaking vs non-breaking.**

- **Breaking**: removing a field, narrowing an enum, changing a type, changing signing inputs, changing canonical encoding rules.
- **Non-breaking**: adding an optional field, adding an error code, widening an enum (game must tolerate unknown values), adding a new endpoint, adding a new event type.

Games SHOULD declare the highest `protocolVersion` they support; the platform negotiates down and refuses if no overlap exists.

---

## 11. Quick reference

| Thing | Where |
|---|---|
| Game registration | §3.1, signed by `devPubkey` |
| Match-start delivery | §3.2 + §5.1 (webhook) or in-process (MANAGED) |
| Outcome submission | §3.3, signed by `attestorPubkey`, posted to `outcomeEndpoint` |
| Replay upload | §3.4 + §3.4.1, canonical JSON keyed by matchId, single-writer per match |
| Replay storage API | `platform.uploadReplay` / `platform.getReplay` (SDK); `replays.put` / `replays.get` (tRPC) |
| Signing inputs | §4.1 — Borsh bytes of OutcomeBody |
| Hash inputs | §4.2 — canonical JSON of Replay |
| Auth headers | §5.1 (webhook) and §5.2 (REST) |
| Stub network | §5.4 — `network: "stub"` for local dev |
| Error codes | §6 |
| State alignment | §7 |
| Pacman example | §8 |

---

## Changelog

- **v0 — 2026-05-13**: Initial draft. Four payloads, ed25519 + Borsh signing, canonical-JSON replays, tRPC-canonical with REST shim transport, stub network for local dev.
- **v0.1 — 2026-05-13**: Replay storage v0 concretized. SDK gains `uploadReplay`/`getReplay`; services tier gains `replays.put`/`replays.get` tRPC procedures. Process-local in-memory store shared between SDK and services. Canonical-JSON helper moved into `@x1-labs/games-protocol` (`canonicalJson`, `canonicalSha256`). Production-grade RFC 8785 + content-addressed object storage deferred — surface contract is stable.
