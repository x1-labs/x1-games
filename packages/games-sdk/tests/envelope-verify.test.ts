import { afterEach, describe, expect, test } from "bun:test";
import { Platform, __resetStub, verifyOutcomeEnvelope } from "../src/index";

// Sign + verify roundtrip for OutcomeEnvelope. Exercises the stub backend
// because the verifier is backend-agnostic — the canonical signing payload
// and borsh encoding are the same as what SolanaBackend produces against a
// real validator (chain integration tests cover the chain side end-to-end).

afterEach(() => __resetStub());

const SHA_HEX = "0x" + "4f".repeat(32);
const HASH_HEX = "0x" + "cd".repeat(32);

async function setup() {
  const dev = Platform.connect({ network: "stub" });
  const player = Platform.connect({ network: "stub" });
  await dev.registerGame({
    protocolVersion: "v0",
    id: "pacman",
    displayName: "Pacman",
    tier: "DEMO",
    runtime: "MANAGED",
    attestationModels: ["TRUSTED"],
    seats: { min: 1, max: 4 },
    simulator: { kind: "server", sha256: SHA_HEX },
    devPubkey: dev.pubkey,
    attestorPubkey: dev.pubkey,
    revenueReceiver: dev.pubkey,
    joinUrlTemplate: "https://example.test/play/{matchId}",
    metadataUri: "https://example.test/pacman.json",
  });
  const m = await dev.createMatch({
    gameId: "pacman",
    seats: 1,
    stakePerSeat: "1000000000",
    housePrize: "10000000000",
    rakeBps: 300,
    model: "TRUSTED",
    fundingDeadlineSec: 600,
    settlementDeadlineSec: 3600,
  });
  await player.joinMatch({ matchId: m.matchId });
  return { dev, player, matchId: m.matchId };
}

describe("OutcomeEnvelope sign + verify", () => {
  test("envelopes produced by the stub verify against their own attestor", async () => {
    const { dev, player, matchId } = await setup();
    const env = await dev.signAndPostOutcome({
      matchId,
      gameId: "pacman",
      winners: [player.pubkey],
      payoutShares: ["10670000000"],
      replayHash: HASH_HEX,
      idempotencyKey: "verify-test-1",
    });

    // Sanity: signature is real ed25519 (64 bytes hex-encoded = 130 chars + "0x").
    expect(env.signature).toMatch(/^0x[0-9a-f]{128}$/);

    const result = verifyOutcomeEnvelope(env);
    expect(result.ok, `verify failed: ${result.reason}`).toBe(true);
    expect(result.reason).toBeNull();
  });

  test("rejects an envelope whose attestor pubkey was swapped (signature won't verify)", async () => {
    const { dev, player, matchId } = await setup();
    const env = await dev.signAndPostOutcome({
      matchId,
      gameId: "pacman",
      winners: [player.pubkey],
      payoutShares: ["10670000000"],
      replayHash: HASH_HEX,
      idempotencyKey: "verify-test-2",
    });
    const tampered = {
      ...env,
      outcome: { ...env.outcome, attestor: player.pubkey }, // wrong attestor
    };
    const result = verifyOutcomeEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signature does not verify/i);
  });

  test("rejects an envelope whose payoutShares were edited but borsh wasn't", async () => {
    const { dev, player, matchId } = await setup();
    const env = await dev.signAndPostOutcome({
      matchId,
      gameId: "pacman",
      winners: [player.pubkey],
      payoutShares: ["10670000000"],
      replayHash: HASH_HEX,
      idempotencyKey: "verify-test-3",
    });
    const tampered = {
      ...env,
      outcome: { ...env.outcome, payoutShares: ["99999999999"] },
    };
    const result = verifyOutcomeEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/payouts\[0\] differs|payouts length differs/i);
  });

  test("rejects an envelope with a malformed borsh blob", async () => {
    const { dev, player, matchId } = await setup();
    const env = await dev.signAndPostOutcome({
      matchId,
      gameId: "pacman",
      winners: [player.pubkey],
      payoutShares: ["10670000000"],
      replayHash: HASH_HEX,
      idempotencyKey: "verify-test-4",
    });
    const tampered = { ...env, borsh: "0xdeadbeef" };
    const result = verifyOutcomeEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/borsh|payouts|signature/i);
  });
});
