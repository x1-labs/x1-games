import anchor from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { expect } from "chai";
import { Platform } from "@x1-labs/games-sdk";
import { appRouter, createCallerFactory } from "@x1-labs/games-services";

// End-to-end test of the services tRPC procedures against the deployed
// programs. Validates that the same chain reads exposed by the SDK are
// reachable via the public API surface that third-party UIs will consume.

const { Keypair, LAMPORTS_PER_SOL } = pkg;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const createCaller = createCallerFactory(appRouter);

async function airdrop(to: pkg.PublicKey, lamports: number) {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

const SHA = "0x" + "55".repeat(32);

describe("services tRPC — backed by chain", () => {
  it("games.list returns registered games; games.get returns one", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    const devPlatform = Platform.connect({
      network: "x1-localnet",
      signer: dev,
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const gameIdStr = `svc-list-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    await devPlatform.registerGame({
      protocolVersion: "v0",
      id: gameIdStr,
      displayName: "Service List Test",
      tier: "DEMO",
      runtime: "MANAGED",
      attestationModels: ["TRUSTED"],
      seats: { min: 1, max: 2 },
      simulator: { kind: "server", sha256: SHA },
      devPubkey: dev.publicKey.toBase58(),
      attestorPubkey: dev.publicKey.toBase58(),
      revenueReceiver: dev.publicKey.toBase58(),
      joinUrlTemplate: "https://example.test/play/{matchId}",
      metadataUri: "https://example.test/m.json",
    });

    // Service uses its own read-only Platform pointed at the same RPC.
    const servicePlatform = Platform.connect({
      network: "x1-localnet",
      signer: Keypair.generate(),
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const caller = createCaller({ platform: servicePlatform });

    const list = await caller.games.list();
    const ids = list.map((g) => g.gameId);
    expect(ids).to.include(gameIdStr);

    const one = await caller.games.get({ id: gameIdStr });
    expect(one.gameId).to.equal(gameIdStr);
    expect(one.tier).to.equal("DEMO");
    expect(one.devPubkey).to.equal(dev.publicKey.toBase58());
    expect(one.seatsMin).to.equal(1);
    expect(one.seatsMax).to.equal(2);
  });

  it("lobbies.get returns a freshly-created match's view", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    const devPlatform = Platform.connect({
      network: "x1-localnet",
      signer: dev,
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const gameIdStr = `svc-lob-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    await devPlatform.registerGame({
      protocolVersion: "v0",
      id: gameIdStr,
      displayName: "Service Lobby Test",
      tier: "DEMO",
      runtime: "MANAGED",
      attestationModels: ["TRUSTED"],
      seats: { min: 1, max: 2 },
      simulator: { kind: "server", sha256: SHA },
      devPubkey: dev.publicKey.toBase58(),
      attestorPubkey: dev.publicKey.toBase58(),
      revenueReceiver: dev.publicKey.toBase58(),
      joinUrlTemplate: "https://example.test/play/{matchId}",
      metadataUri: "https://example.test/m.json",
    });
    const treasury = Keypair.generate();
    await airdrop(treasury.publicKey, 1);
    const { matchId } = await devPlatform.createMatch({
      gameId: gameIdStr,
      seats: 2,
      stakePerSeat: "1000000",
      housePrize: null,
      rakeBps: 300,
      model: "TRUSTED",
      fundingDeadlineSec: 600,
      settlementDeadlineSec: 3600,
      attestor: dev.publicKey.toBase58(),
      treasury: treasury.publicKey.toBase58(),
    });

    const servicePlatform = Platform.connect({
      network: "x1-localnet",
      signer: Keypair.generate(),
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const caller = createCaller({ platform: servicePlatform });

    const view = await caller.lobbies.get({ matchId });
    expect(view.matchId).to.equal(matchId);
    expect(view.state).to.equal("Created");
    expect(view.seats).to.equal(2);
    expect(view.stakePerSeat).to.equal("1000000");
    expect(view.rakeBps).to.equal(300);
    expect(view.model).to.equal("TRUSTED");
    expect(view.attestorPubkey).to.equal(dev.publicKey.toBase58());
  });

  it("lobbies.list filtered by gameId returns only that game's matches", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, 2 * LAMPORTS_PER_SOL);
    const devPlatform = Platform.connect({
      network: "x1-localnet",
      signer: dev,
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const idA = `svc-flt-a-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    const idB = `svc-flt-b-${Math.floor(Math.random() * 1_000_000).toString(36)}`;

    for (const id of [idA, idB]) {
      await devPlatform.registerGame({
        protocolVersion: "v0",
        id,
        displayName: id,
        tier: "DEMO",
        runtime: "MANAGED",
        attestationModels: ["TRUSTED"],
        seats: { min: 1, max: 2 },
        simulator: { kind: "server", sha256: SHA },
        devPubkey: dev.publicKey.toBase58(),
        attestorPubkey: dev.publicKey.toBase58(),
        revenueReceiver: dev.publicKey.toBase58(),
        joinUrlTemplate: "https://example.test/play/{matchId}",
        metadataUri: "https://example.test/m.json",
      });
    }

    const treasury = Keypair.generate();
    await airdrop(treasury.publicKey, 1);
    // Two matches under idA, one under idB.
    const baseArgs = {
      stakePerSeat: "100000",
      housePrize: null,
      rakeBps: 300,
      model: "TRUSTED" as const,
      fundingDeadlineSec: 600,
      settlementDeadlineSec: 3600,
      attestor: dev.publicKey.toBase58(),
      treasury: treasury.publicKey.toBase58(),
      seats: 2,
    };
    const a1 = await devPlatform.createMatch({ gameId: idA, ...baseArgs });
    const a2 = await devPlatform.createMatch({ gameId: idA, ...baseArgs });
    const b1 = await devPlatform.createMatch({ gameId: idB, ...baseArgs });

    const servicePlatform = Platform.connect({
      network: "x1-localnet",
      signer: Keypair.generate(),
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const caller = createCaller({ platform: servicePlatform });

    const matchesForA = await caller.lobbies.list({ gameId: idA });
    const idsA = matchesForA.map((m) => m.matchId);
    expect(idsA).to.include(a1.matchId);
    expect(idsA).to.include(a2.matchId);
    expect(idsA).to.not.include(b1.matchId);

    const matchesForB = await caller.lobbies.list({ gameId: idB });
    const idsB = matchesForB.map((m) => m.matchId);
    expect(idsB).to.include(b1.matchId);
    expect(idsB).to.not.include(a1.matchId);
  });

  it("xp.get returns zero for an un-played player and the real balance after credit", async () => {
    const dev = Keypair.generate();
    const player = Keypair.generate();
    const treasury = Keypair.generate();
    await airdrop(dev.publicKey, 2 * LAMPORTS_PER_SOL);
    await airdrop(player.publicKey, LAMPORTS_PER_SOL);
    await airdrop(treasury.publicKey, 1);

    const devPlatform = Platform.connect({
      network: "x1-localnet",
      signer: dev,
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const playerPlatform = Platform.connect({
      network: "x1-localnet",
      signer: player,
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const servicePlatform = Platform.connect({
      network: "x1-localnet",
      signer: Keypair.generate(),
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const caller = createCaller({ platform: servicePlatform });

    const gameIdStr = `svc-xp-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    await devPlatform.registerGame({
      protocolVersion: "v0",
      id: gameIdStr,
      displayName: "XP Service Test",
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

    // Before any play: zero.
    const before = await caller.xp.get({ gameId: gameIdStr, player: player.publicKey.toBase58() });
    expect(before.amount).to.equal("0");

    // Settle a match in the player's favor and credit.
    const { matchId } = await devPlatform.createMatch({
      gameId: gameIdStr,
      seats: 1,
      stakePerSeat: "1000000",
      housePrize: null,
      rakeBps: 300,
      model: "TRUSTED",
      fundingDeadlineSec: 600,
      settlementDeadlineSec: 3600,
      attestor: dev.publicKey.toBase58(),
      treasury: treasury.publicKey.toBase58(),
    });
    await playerPlatform.joinMatch({ matchId });
    await devPlatform.signAndPostOutcome({
      matchId,
      gameId: gameIdStr,
      winners: [player.publicKey.toBase58()],
      payoutShares: [(1_000_000 - 30_000).toString()],
      replayHash: "0x" + "11".repeat(32),
      idempotencyKey: `svc-xp-${matchId}-1`,
    });
    await devPlatform.creditXp({ matchId, player: player.publicKey.toBase58() });

    const after = await caller.xp.get({ gameId: gameIdStr, player: player.publicKey.toBase58() });
    expect(after.amount).to.equal("100");
    expect(after.player).to.equal(player.publicKey.toBase58());
  });
});
