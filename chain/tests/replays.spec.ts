import { anchor, web3 as pkg } from "./_anchor.ts";
import { expect } from "chai";
import { Platform } from "@x1-labs/games-sdk";
import { appRouter, createCallerFactory } from "@x1-labs/games-services";
import { canonicalSha256 } from "@x1-labs/games-protocol";

// End-to-end replay storage: TTT-style flow uploads a replay, the on-chain
// outcome commits the same hash, and the replay is fetchable via the services
// tRPC API. Validates that the off-chain storage contract is byte-aligned
// with the on-chain commitment.

const { Keypair, LAMPORTS_PER_SOL } = pkg;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const createCaller = createCallerFactory(appRouter);

async function airdrop(to: pkg.PublicKey, lamports: number) {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

const SHA = "0x" + "99".repeat(32);

describe("replay storage end-to-end", () => {
  it("uploaded replay hash matches the on-chain commitment", async () => {
    const dev = Keypair.generate();
    const player = Keypair.generate();
    const treasury = Keypair.generate();
    await airdrop(dev.publicKey, 2 * LAMPORTS_PER_SOL);
    await airdrop(player.publicKey, LAMPORTS_PER_SOL);
    await airdrop(treasury.publicKey, 1);

    const rpcUrl = provider.connection.rpcEndpoint;
    const devPlatform = Platform.connect({ network: "x1-localnet", signer: dev, rpcUrl });
    const playerPlatform = Platform.connect({ network: "x1-localnet", signer: player, rpcUrl });

    const gameIdStr = `rep-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    await devPlatform.registerGame({
      protocolVersion: "v0",
      id: gameIdStr,
      displayName: "Replay Test",
      tier: "DEMO",
      runtime: "MANAGED",
      attestationModels: ["TRUSTED"],
      seats: { min: 1, max: 1 },
      simulator: { kind: "server", sha256: SHA },
      devPubkey: dev.publicKey.toBase58(),
      attestorPubkey: dev.publicKey.toBase58(),
      revenueReceiver: dev.publicKey.toBase58(),
      joinUrlTemplate: "https://example.test/play/{matchId}",
      metadataUri: "https://example.test/m.json",
    });

    const stake = 1_000_000;
    const rakeBps = 300;
    const expectedPayout = stake - Math.floor((stake * rakeBps) / 10_000);
    const { matchId } = await devPlatform.createMatch({
      gameId: gameIdStr,
      seats: 1,
      stakePerSeat: stake.toString(),
      housePrize: null,
      rakeBps,
      model: "TRUSTED",
      fundingDeadlineSec: 600,
      settlementDeadlineSec: 3600,
      attestor: dev.publicKey.toBase58(),
      treasury: treasury.publicKey.toBase58(),
    });
    await playerPlatform.joinMatch({ matchId });

    // 1. Build the canonical Replay and upload via SDK.
    const replay = {
      protocolVersion: "v0" as const,
      matchId,
      gameId: gameIdStr,
      simulatorSha256: SHA,
      seed: "0x" + "0123456789abcdef",
      initialState: { board: [null, null, null, null, null, null, null, null, null] },
      finalState: { winner: player.publicKey.toBase58(), score: 100 },
      inputs: [{ tick: 0, playerIndex: 0, data: { cell: 4 } }],
      startedAt: 1700000000,
      endedAt: 1700000010,
    };
    const uploaded = await devPlatform.uploadReplay({ replay });
    // SDK-side hash matches a direct canonicalSha256 of the same body.
    expect(uploaded.replayHash).to.equal(canonicalSha256(replay));

    // 2. Post the outcome using the uploaded hash.
    await devPlatform.signAndPostOutcome({
      matchId,
      gameId: gameIdStr,
      winners: [player.publicKey.toBase58()],
      payoutShares: [expectedPayout.toString()],
      replayHash: uploaded.replayHash,
      idempotencyKey: `rep-${matchId}-outcome`,
    });

    // 3. On-chain commitment matches the off-chain hash.
    const m = await devPlatform.getMatch(matchId);
    expect(m.state).to.equal("Paid");
    expect(m.outcome!.replayHash).to.equal(uploaded.replayHash);

    // 4. Replay is fetchable via the services tRPC API.
    const servicePlatform = Platform.connect({
      network: "x1-localnet",
      signer: Keypair.generate(),
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const caller = createCaller({ platform: servicePlatform });
    const fetched = await caller.replays.get({ matchId });
    expect(fetched.replayHash).to.equal(uploaded.replayHash);
    expect(fetched.replay.gameId).to.equal(gameIdStr);
    expect(fetched.replay.inputs).to.have.lengthOf(1);
  });

  it("replays.put via tRPC stores a replay that the SDK can then read back", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    const devPlatform = Platform.connect({
      network: "x1-localnet",
      signer: dev,
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const caller = createCaller({ platform: devPlatform });

    // A faux matchId — only the storage layer is being exercised here.
    const matchId = "11111111111111111111111111111111";
    const replay = {
      protocolVersion: "v0" as const,
      matchId,
      gameId: "demo",
      simulatorSha256: SHA,
      seed: "0x" + "fedcba9876543210",
      initialState: { x: 1 },
      finalState: { x: 2 },
      inputs: [],
      startedAt: 1700000000,
      endedAt: 1700000001,
    };
    const put = await caller.replays.put({ replay });
    expect(put.replayHash).to.equal(canonicalSha256(replay));

    const got = await devPlatform.getReplay({ matchId });
    expect(got.replayHash).to.equal(put.replayHash);
    expect(got.replay.gameId).to.equal("demo");
  });
});
