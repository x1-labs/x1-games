// @x1-labs/games-protocol — v0 schemas for the X1 Games integration contract.
// Canonical reference: INTEGRATION.md at the repo root.
//
// These schemas are the *shape* contract. The doc is the *narrative* contract.
// Divergence between the two is a bug in the schemas, not in the doc.

import { z } from "zod";
import bs58 from "bs58";

export { canonicalJson, canonicalSha256, sha256Hex } from "./canonical.js";
export {
  getDefaultReplayStore,
  type StoredReplay,
  type InMemoryReplayStore,
} from "./replay-store.js";

// =============================================================================
// Primitives (INTEGRATION.md §2)
// =============================================================================

/** 32-byte ed25519 public key, base58-encoded. Length 32–44 chars.
 *  Validates that the string actually base58-decodes to 32 bytes — the regex
 *  check alone admits many strings that aren't valid pubkeys. */
export const Pubkey = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must be base58")
  .refine(
    (s) => {
      try {
        return bs58.decode(s).length === 32;
      } catch {
        return false;
      }
    },
    { message: "must base58-decode to exactly 32 bytes" },
  );
export type Pubkey = z.infer<typeof Pubkey>;

/** 64-byte ed25519 signature, 0x-prefixed lowercase hex (130 chars). */
export const Signature = z.string().regex(/^0x[0-9a-f]{128}$/);
export type Signature = z.infer<typeof Signature>;

/** 32-byte digest, 0x-prefixed lowercase hex (66 chars). */
export const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
export type Hash = z.infer<typeof Hash>;

/** 8-byte value (u64), 0x-prefixed lowercase hex (18 chars). Used for seeds. */
export const HexU64 = z.string().regex(/^0x[0-9a-f]{16}$/);
export type HexU64 = z.infer<typeof HexU64>;

/** Stable per-game id: lowercase ASCII, [a-z0-9-], 3–32 chars. */
export const GameId = z.string().regex(/^[a-z0-9-]{3,32}$/);
export type GameId = z.infer<typeof GameId>;

/** On-chain Match PDA. Same shape as Pubkey. */
export const MatchId = Pubkey;
export type MatchId = z.infer<typeof MatchId>;

/** Unsigned 64-bit lamport amount, expressed as a base-10 string. */
const U64_MAX = 18446744073709551615n;
export const XntLamports = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "must be a non-negative integer literal")
  .refine((s) => BigInt(s) <= U64_MAX, "exceeds u64 max");
export type XntLamports = z.infer<typeof XntLamports>;

/** Unix timestamp in seconds, i64. Permissive lower bound. */
export const UnixSec = z.number().int().min(0).max(2 ** 53 - 1);
export type UnixSec = z.infer<typeof UnixSec>;

/** Idempotency key — short, unique-per-operation, <=64 chars. */
export const IdempotencyKey = z.string().min(1).max(64);
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

// =============================================================================
// Enumerations
// =============================================================================

export const AttestationModel = z.enum(["TRUSTED", "COSIGNED", "OPTIMISTIC", "ZK"]);
export type AttestationModel = z.infer<typeof AttestationModel>;

export const Tier = z.enum(["DEMO", "LIVE", "FEATURED"]);
export type Tier = z.infer<typeof Tier>;

export const Runtime = z.enum(["MANAGED", "SELF_HOSTED"]);
export type Runtime = z.infer<typeof Runtime>;

export const ProtocolVersion = z.literal("v0");
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;

// =============================================================================
// GameRegistration (§3.1)
// =============================================================================

const Seats = z
  .object({
    min: z.number().int().min(1).max(16),
    max: z.number().int().min(1).max(16),
  })
  .refine((s) => s.max >= s.min, { message: "seats.max must be >= seats.min" });

const SimulatorRef = z.object({
  kind: z.enum(["wasm", "server"]),
  uri: z.string().url().optional(),
  sha256: Hash,
});

export const GameRegistration = z.object({
  protocolVersion: ProtocolVersion,
  id: GameId,
  displayName: z.string().min(1).max(64),
  tier: Tier,
  runtime: Runtime,
  attestationModels: z.array(AttestationModel).min(1),
  seats: Seats,
  simulator: SimulatorRef,
  devPubkey: Pubkey,
  attestorPubkey: Pubkey,
  revenueReceiver: Pubkey,
  webhookUrl: z.string().url().optional(),
  joinUrlTemplate: z.string().min(1),
  metadataUri: z.string().url(),
});
export type GameRegistration = z.infer<typeof GameRegistration>;

// =============================================================================
// MatchStart (§3.2)
// =============================================================================

export const MatchStart = z.object({
  protocolVersion: ProtocolVersion,
  matchId: MatchId,
  gameId: GameId,
  seed: HexU64,
  seats: z.number().int().min(1).max(16),
  stakePerSeat: XntLamports,
  housePrize: XntLamports.nullable(),
  rakeBps: z.number().int().min(0).max(1000),
  model: AttestationModel,
  players: z.array(Pubkey).min(1).max(16),
  attestorPubkey: Pubkey,
  fundingDeadline: UnixSec,
  settlementDeadline: UnixSec,
  outcomeEndpoint: z.string().url(),
  replayUploadUrl: z.string().url().nullable(),
});
export type MatchStart = z.infer<typeof MatchStart>;

// =============================================================================
// OutcomeBody / OutcomeEnvelope (§3.3)
// =============================================================================

export const OutcomeBody = z
  .object({
    matchId: MatchId,
    winners: z.array(Pubkey).min(1).max(16),
    payoutShares: z.array(XntLamports).min(1).max(16),
    replayHash: Hash,
    postedAt: UnixSec,
    attestor: Pubkey,
  })
  .refine((o) => o.winners.length === o.payoutShares.length, {
    message: "winners.length must equal payoutShares.length",
  });
export type OutcomeBody = z.infer<typeof OutcomeBody>;

export const OutcomeEnvelope = z.object({
  protocolVersion: ProtocolVersion,
  outcome: OutcomeBody,
  borsh: z.string().regex(/^0x[0-9a-f]+$/),
  signature: Signature,
  idempotencyKey: IdempotencyKey,
});
export type OutcomeEnvelope = z.infer<typeof OutcomeEnvelope>;

// =============================================================================
// Replay (§3.4)
// =============================================================================

const ReplayInput = z.object({
  tick: z.number().int().min(0),
  playerIndex: z.number().int().min(0).max(15),
  data: z.unknown(),
});

export const Replay = z.object({
  protocolVersion: ProtocolVersion,
  matchId: MatchId,
  gameId: GameId,
  simulatorSha256: Hash,
  seed: HexU64,
  initialState: z.unknown(),
  finalState: z.unknown(),
  inputs: z.array(ReplayInput),
  startedAt: UnixSec,
  endedAt: UnixSec,
});
export type Replay = z.infer<typeof Replay>;

// =============================================================================
// Errors (§6)
// =============================================================================

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
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  protocolVersion: ProtocolVersion,
  code: ErrorCode,
  message: z.string(),
  detail: z.record(z.unknown()).optional(),
  retryable: z.boolean(),
  requestId: z.string().min(1),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
