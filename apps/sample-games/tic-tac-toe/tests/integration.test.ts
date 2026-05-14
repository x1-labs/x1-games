import { afterEach, describe, expect, test } from "bun:test";
import { Platform, __resetStub } from "@x1-labs/games-sdk";
import { TttGameServer } from "../src/server";

const SHA_HEX = "0x" + "4f".repeat(32);

afterEach(() => __resetStub());

async function registerTtt(platform: ReturnType<typeof Platform.connect>) {
  return platform.registerGame({
    protocolVersion: "v0",
    id: "tic-tac-toe",
    displayName: "Tic-Tac-Toe",
    tier: "DEMO",
    runtime: "MANAGED",
    attestationModels: ["TRUSTED"],
    seats: { min: 2, max: 2 },
    simulator: { kind: "server", sha256: SHA_HEX },
    devPubkey: platform.pubkey,
    attestorPubkey: platform.pubkey,
    revenueReceiver: platform.pubkey,
    joinUrlTemplate: "https://ttt.x1-labs.dev/play/{matchId}",
    metadataUri: "https://ttt.x1-labs.dev/metadata.json",
  });
}

interface Setup {
  dev: ReturnType<typeof Platform.connect>;
  playerA: ReturnType<typeof Platform.connect>;
  playerB: ReturnType<typeof Platform.connect>;
  server: TttGameServer;
  matchId: string;
}

async function setUpFundedMatch(): Promise<Setup> {
  const dev = Platform.connect({ network: "stub" });
  const playerA = Platform.connect({ network: "stub" });
  const playerB = Platform.connect({ network: "stub" });

  await registerTtt(dev);
  const server = new TttGameServer({ platform: dev });

  const { matchId } = await dev.createMatch({
    gameId: "tic-tac-toe",
    seats: 2,
    stakePerSeat: "5000000000",
    housePrize: null,
    rakeBps: 300,
    model: "TRUSTED",
    fundingDeadlineSec: 600,
    settlementDeadlineSec: 3600,
  });
  await playerA.joinMatch({ matchId });
  await playerB.joinMatch({ matchId });

  return { dev, playerA, playerB, server, matchId };
}

describe("TttGameServer — end-to-end against SDK stub", () => {
  test("PLAYER_A wins: outcome lands, stub shows Settled", async () => {
    const { dev, playerA, playerB, server, matchId } = await setUpFundedMatch();

    server.submitMove({ matchId, player: playerA.pubkey, cell: 0 });
    server.submitMove({ matchId, player: playerB.pubkey, cell: 3 });
    server.submitMove({ matchId, player: playerA.pubkey, cell: 1 });
    server.submitMove({ matchId, player: playerB.pubkey, cell: 4 });
    await server.submitMove({ matchId, player: playerA.pubkey, cell: 2 });

    const m = await dev.getMatch(matchId);
    expect(m.state).toBe("Paid");
    expect(m.outcome?.winners).toEqual([playerA.pubkey]);
    expect(m.outcome?.payoutShares).toEqual(["9700000000"]);
  });

  test("PLAYER_B wins: payouts go to B", async () => {
    const { dev, playerA, playerB, server, matchId } = await setUpFundedMatch();

    server.submitMove({ matchId, player: playerA.pubkey, cell: 4 });
    server.submitMove({ matchId, player: playerB.pubkey, cell: 0 });
    server.submitMove({ matchId, player: playerA.pubkey, cell: 1 });
    server.submitMove({ matchId, player: playerB.pubkey, cell: 3 });
    server.submitMove({ matchId, player: playerA.pubkey, cell: 2 });
    await server.submitMove({ matchId, player: playerB.pubkey, cell: 6 });

    const m = await dev.getMatch(matchId);
    expect(m.state).toBe("Paid");
    expect(m.outcome?.winners).toEqual([playerB.pubkey]);
  });

  test("draw: pot split between both players", async () => {
    const { dev, playerA, playerB, server, matchId } = await setUpFundedMatch();

    const moves: Array<[string, number]> = [
      [playerA.pubkey, 0], [playerB.pubkey, 1], [playerA.pubkey, 2],
      [playerB.pubkey, 5], [playerA.pubkey, 4], [playerB.pubkey, 8],
      [playerA.pubkey, 3], [playerB.pubkey, 6], [playerA.pubkey, 7],
    ];
    for (const [player, cell] of moves) {
      await server.submitMove({ matchId, player, cell });
    }

    const m = await dev.getMatch(matchId);
    expect(m.state).toBe("Paid");
    expect(m.outcome?.winners).toEqual([playerA.pubkey, playerB.pubkey]);
    expect(m.outcome?.payoutShares).toEqual(["4850000000", "4850000000"]);
  });

  test("rejects moves for an unknown matchId", async () => {
    const dev = Platform.connect({ network: "stub" });
    await registerTtt(dev);
    const server = new TttGameServer({ platform: dev });
    expect(() =>
      server.submitMove({ matchId: "nonexistent", player: dev.pubkey, cell: 0 }),
    ).toThrow(/no session/i);
  });

  test("outcome submission is idempotent (no duplicate settlement on retry)", async () => {
    const { dev, playerA, playerB, server, matchId } = await setUpFundedMatch();

    server.submitMove({ matchId, player: playerA.pubkey, cell: 0 });
    server.submitMove({ matchId, player: playerB.pubkey, cell: 3 });
    server.submitMove({ matchId, player: playerA.pubkey, cell: 1 });
    server.submitMove({ matchId, player: playerB.pubkey, cell: 4 });
    await server.submitMove({ matchId, player: playerA.pubkey, cell: 2 });

    await server.settleNow(matchId);

    const m = await dev.getMatch(matchId);
    expect(m.state).toBe("Paid");
  });
});
