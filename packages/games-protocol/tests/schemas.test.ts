import { describe, expect, test } from "bun:test";
import {
  GameRegistration,
  MatchStart,
  OutcomeBody,
  OutcomeEnvelope,
  Replay,
  ErrorEnvelope,
  ErrorCode,
  Pubkey,
  Signature,
  Hash,
  XntLamports,
  HexU64,
} from "../src/index";

// Helpers — well-formed fixtures derived from INTEGRATION.md §8.
const PUBKEY_A = "9xQeWvG816bUx9EPa2Lh9KqWa1KcvqtfgUnTeMSPMuLP";
const PUBKEY_B = "Br9c7M2NjQDJ4D9KsELRZ2VK6QqYJZ5xWPzCgVnB3uvF";
const ATTESTOR = "AttkX3uvJ9KsELRZ2VK6QqYJZ5xWPzCgVnB3uvFnK8Mz";
const SIG_HEX = "0x" + "ab".repeat(64);
const HASH_HEX = "0x" + "cd".repeat(32);
const SEED_HEX = "0x7a3f2c91d4e08b15";
const SHA_HEX = "0x" + "4f".repeat(32);

function validGameRegistration() {
  return {
    protocolVersion: "v0" as const,
    id: "pacman",
    displayName: "Pacman",
    tier: "DEMO" as const,
    runtime: "MANAGED" as const,
    attestationModels: ["TRUSTED" as const, "OPTIMISTIC" as const],
    seats: { min: 1, max: 4 },
    simulator: { kind: "server" as const, sha256: SHA_HEX },
    devPubkey: PUBKEY_A,
    attestorPubkey: ATTESTOR,
    revenueReceiver: PUBKEY_A,
    joinUrlTemplate: "https://pacman.x1-labs.dev/play/{matchId}",
    metadataUri: "https://example.com/pacman.json",
  };
}

function validMatchStart() {
  return {
    protocolVersion: "v0" as const,
    matchId: PUBKEY_B,
    gameId: "pacman",
    seed: SEED_HEX,
    seats: 1,
    stakePerSeat: "5000000000",
    housePrize: "50000000000",
    rakeBps: 300,
    model: "OPTIMISTIC" as const,
    players: [PUBKEY_A],
    attestorPubkey: ATTESTOR,
    fundingDeadline: 1747136400,
    settlementDeadline: 1747140000,
    outcomeEndpoint: "https://api.x1-labs.dev/v0/games/pacman/matches/Br9c/outcome",
    replayUploadUrl: "https://replays.x1-labs.dev/abc?signed=xyz",
  };
}

function validOutcomeBody() {
  return {
    matchId: PUBKEY_B,
    winners: [PUBKEY_A],
    payoutShares: ["53350000000"],
    replayHash: HASH_HEX,
    postedAt: 1747136580,
    attestor: ATTESTOR,
  };
}

function validOutcomeEnvelope() {
  return {
    protocolVersion: "v0" as const,
    outcome: validOutcomeBody(),
    borsh: "0xdeadbeef",
    signature: SIG_HEX,
    idempotencyKey: "pacman-Br9c-outcome-1",
  };
}

function validReplay() {
  return {
    protocolVersion: "v0" as const,
    matchId: PUBKEY_B,
    gameId: "pacman",
    simulatorSha256: SHA_HEX,
    seed: SEED_HEX,
    initialState: { maze: "classic", lives: 3 },
    finalState: { score: 12450, status: "won" },
    inputs: [
      { tick: 0, playerIndex: 0, data: { dir: "right" } },
      { tick: 12, playerIndex: 0, data: { dir: "up" } },
    ],
    startedAt: 1747136500,
    endedAt: 1747136580,
  };
}

// --- primitives ----------------------------------------------------------

describe("primitive schemas", () => {
  test("Pubkey accepts base58 string of 32–44 chars", () => {
    expect(Pubkey.safeParse(PUBKEY_A).success).toBe(true);
    expect(Pubkey.safeParse("too-short").success).toBe(false);
    expect(Pubkey.safeParse("0OIl").success).toBe(false); // invalid base58 chars
  });

  test("Signature is 0x-prefixed 128 lowercase hex", () => {
    expect(Signature.safeParse(SIG_HEX).success).toBe(true);
    expect(Signature.safeParse(SIG_HEX.toUpperCase()).success).toBe(false);
    expect(Signature.safeParse("0xab").success).toBe(false);
  });

  test("Hash is 0x-prefixed 64 lowercase hex", () => {
    expect(Hash.safeParse(HASH_HEX).success).toBe(true);
    expect(Hash.safeParse("0xCD".repeat(32)).success).toBe(false);
  });

  test("XntLamports is a digit string within u64 range", () => {
    expect(XntLamports.safeParse("0").success).toBe(true);
    expect(XntLamports.safeParse("18446744073709551615").success).toBe(true);
    expect(XntLamports.safeParse("18446744073709551616").success).toBe(false);
    expect(XntLamports.safeParse("-1").success).toBe(false);
    expect(XntLamports.safeParse(5).success).toBe(false);
  });

  test("HexU64 is 0x + exactly 16 hex chars", () => {
    expect(HexU64.safeParse(SEED_HEX).success).toBe(true);
    expect(HexU64.safeParse("0xabc").success).toBe(false);
    expect(HexU64.safeParse("0x" + "0".repeat(17)).success).toBe(false);
  });
});

// --- GameRegistration ----------------------------------------------------

describe("GameRegistration", () => {
  test("valid registration round-trips", () => {
    const r = GameRegistration.parse(validGameRegistration());
    expect(r.id).toBe("pacman");
    expect(r.attestationModels).toContain("TRUSTED");
  });

  test("rejects ill-formed game id", () => {
    const bad = { ...validGameRegistration(), id: "Pacman_Game" };
    expect(GameRegistration.safeParse(bad).success).toBe(false);
  });

  test("rejects seats.max < seats.min", () => {
    const bad = { ...validGameRegistration(), seats: { min: 4, max: 1 } };
    expect(GameRegistration.safeParse(bad).success).toBe(false);
  });

  test("rejects empty attestationModels", () => {
    const bad = { ...validGameRegistration(), attestationModels: [] };
    expect(GameRegistration.safeParse(bad).success).toBe(false);
  });

  test("rejects unknown protocolVersion", () => {
    const bad = { ...validGameRegistration(), protocolVersion: "v1" };
    expect(GameRegistration.safeParse(bad).success).toBe(false);
  });
});

// --- MatchStart ----------------------------------------------------------

describe("MatchStart", () => {
  test("valid solo match-start parses", () => {
    const m = MatchStart.parse(validMatchStart());
    expect(m.seats).toBe(1);
    expect(m.players).toHaveLength(1);
  });

  test("housePrize may be null for PvP", () => {
    const pvp = { ...validMatchStart(), seats: 2, housePrize: null, players: [PUBKEY_A, PUBKEY_B] };
    expect(MatchStart.safeParse(pvp).success).toBe(true);
  });

  test("rakeBps rejected if > 1000", () => {
    const bad = { ...validMatchStart(), rakeBps: 1500 };
    expect(MatchStart.safeParse(bad).success).toBe(false);
  });

  test("seed must be 8 bytes hex", () => {
    const bad = { ...validMatchStart(), seed: "0xdeadbeef" };
    expect(MatchStart.safeParse(bad).success).toBe(false);
  });

  test("replayUploadUrl may be null (for non-OPTIMISTIC)", () => {
    const trusted = { ...validMatchStart(), model: "TRUSTED" as const, replayUploadUrl: null };
    expect(MatchStart.safeParse(trusted).success).toBe(true);
  });
});

// --- OutcomeBody / OutcomeEnvelope --------------------------------------

describe("OutcomeBody", () => {
  test("solo winner parses", () => {
    const o = OutcomeBody.parse(validOutcomeBody());
    expect(o.winners).toHaveLength(1);
    expect(o.payoutShares).toHaveLength(1);
  });

  test("rejects mismatched winners.length vs payoutShares.length", () => {
    const bad = { ...validOutcomeBody(), winners: [PUBKEY_A, PUBKEY_B], payoutShares: ["1"] };
    expect(OutcomeBody.safeParse(bad).success).toBe(false);
  });

  test("rejects empty winners", () => {
    const bad = { ...validOutcomeBody(), winners: [], payoutShares: [] };
    expect(OutcomeBody.safeParse(bad).success).toBe(false);
  });
});

describe("OutcomeEnvelope", () => {
  test("valid envelope parses", () => {
    const e = OutcomeEnvelope.parse(validOutcomeEnvelope());
    expect(e.outcome.matchId).toBe(PUBKEY_B);
    expect(e.signature).toBe(SIG_HEX);
  });

  test("rejects malformed signature", () => {
    const bad = { ...validOutcomeEnvelope(), signature: "0xabc" };
    expect(OutcomeEnvelope.safeParse(bad).success).toBe(false);
  });

  test("idempotencyKey is capped at 64 chars", () => {
    const bad = { ...validOutcomeEnvelope(), idempotencyKey: "x".repeat(65) };
    expect(OutcomeEnvelope.safeParse(bad).success).toBe(false);
  });
});

// --- Replay --------------------------------------------------------------

describe("Replay", () => {
  test("valid replay parses", () => {
    const r = Replay.parse(validReplay());
    expect(r.inputs).toHaveLength(2);
  });

  test("tick must be non-negative", () => {
    const bad = { ...validReplay(), inputs: [{ tick: -1, playerIndex: 0, data: {} }] };
    expect(Replay.safeParse(bad).success).toBe(false);
  });
});

// --- ErrorEnvelope -------------------------------------------------------

describe("ErrorEnvelope", () => {
  test("known error code parses", () => {
    const e = ErrorEnvelope.parse({
      protocolVersion: "v0",
      code: "InvalidSignature",
      message: "bad sig",
      retryable: false,
      requestId: "req-123",
    });
    expect(e.code).toBe("InvalidSignature");
  });

  test("unknown error code rejected", () => {
    expect(
      ErrorEnvelope.safeParse({
        protocolVersion: "v0",
        code: "DefinitelyNotARealCode",
        message: "x",
        retryable: false,
        requestId: "r",
      }).success,
    ).toBe(false);
  });

  test("ErrorCode enum has both 4xx and 5xx categories", () => {
    expect(ErrorCode.options).toContain("InvalidSignature");
    expect(ErrorCode.options).toContain("ChainUnavailable");
  });
});
