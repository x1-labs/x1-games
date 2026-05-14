import { afterEach, describe, expect, test } from "bun:test";
import { Platform, __resetStub } from "../src/index";
import type { MatchStart, OutcomeEnvelope } from "@x1-labs/games-protocol";

// Per-actor end-to-end flow against the stub. Each actor (dev, player) gets
// its own Platform instance with its own signer; stub state is shared
// process-wide so they see consistent matches.

afterEach(() => __resetStub());

const SHA_HEX = "0x" + "4f".repeat(32);
const HASH_HEX = "0x" + "cd".repeat(32);

describe("stub network end-to-end", () => {
  test("register → create → join → match-start → post outcome → settled", async () => {
    const dev = Platform.connect({ network: "stub" });
    const player = Platform.connect({ network: "stub" });

    const registered = await dev.registerGame({
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
    expect(registered.gameId).toBe("pacman");

    const received: MatchStart[] = [];
    const unsubscribe = dev.subscribeMatchStart("pacman", (event) => {
      received.push(event);
    });

    const created = await dev.createMatch({
      gameId: "pacman",
      seats: 1,
      stakePerSeat: "5000000000",
      housePrize: "50000000000",
      rakeBps: 300,
      model: "TRUSTED",
      fundingDeadlineSec: 600,
      settlementDeadlineSec: 3600,
    });

    await player.joinMatch({ matchId: created.matchId });

    expect(received).toHaveLength(1);
    expect(received[0]!.players).toEqual([player.pubkey]);

    const outcomeEnvelope: OutcomeEnvelope = await dev.signAndPostOutcome({
      matchId: created.matchId,
      gameId: "pacman",
      winners: [player.pubkey],
      payoutShares: ["53350000000"],
      replayHash: HASH_HEX,
      idempotencyKey: "pacman-test-outcome-1",
    });
    expect(outcomeEnvelope.outcome.winners).toEqual([player.pubkey]);

    const m = await dev.getMatch(created.matchId);
    // TRUSTED defaults to challengeWindowSecs=0 → atomic settle+pay.
    expect(m.state).toBe("Paid");
    expect(m.outcome?.winners).toEqual([player.pubkey]);

    unsubscribe();
  });

  test("createMatch is rejected for an unregistered gameId", async () => {
    const dev = Platform.connect({ network: "stub" });
    let failed = false;
    try {
      await dev.createMatch({
        gameId: "not-registered",
        seats: 1,
        stakePerSeat: "1000000000",
        housePrize: null,
        rakeBps: 300,
        model: "TRUSTED",
        fundingDeadlineSec: 600,
        settlementDeadlineSec: 3600,
      });
    } catch (e) {
      failed = true;
      expect((e as Error).message).toMatch(/not registered|NotFound/i);
    }
    expect(failed).toBe(true);
  });

  test("idempotent signAndPostOutcome returns same envelope on retry", async () => {
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

    const args = {
      matchId: m.matchId,
      gameId: "pacman" as const,
      winners: [player.pubkey],
      payoutShares: ["10670000000"],
      replayHash: HASH_HEX,
      idempotencyKey: "retry-test-1",
    };

    const a = await dev.signAndPostOutcome(args);
    const b = await dev.signAndPostOutcome(args);

    expect(a.signature).toBe(b.signature);
    expect(a.outcome.matchId).toBe(b.outcome.matchId);
  });
});
