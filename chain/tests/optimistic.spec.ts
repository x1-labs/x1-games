import anchor from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { expect } from "chai";
import { Platform } from "@x1-labs/games-sdk";

// OPTIMISTIC attestation end-to-end: post settles the match (Live → Settled)
// but does NOT pay out. The challenge window must elapse before finalize_match
// transitions Settled → Paid.

const { Keypair, LAMPORTS_PER_SOL } = pkg;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

async function airdrop(to: pkg.PublicKey, lamports: number) {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

const SHA = "0x" + "77".repeat(32);
const REPLAY = "0x" + "aa".repeat(32);

describe("OPTIMISTIC attestation — end-to-end", () => {
  /** Set up an OPTIMISTIC match funded by one player, post the outcome, and
   *  return the handles needed to drive finalize. */
  async function settledOptimisticMatch(opts: { challengeWindowSecs: number }) {
    const dev = Keypair.generate();
    const player = Keypair.generate();
    const treasury = Keypair.generate();
    await airdrop(dev.publicKey, 2 * LAMPORTS_PER_SOL);
    await airdrop(player.publicKey, LAMPORTS_PER_SOL);
    await airdrop(treasury.publicKey, 1);

    const rpcUrl = provider.connection.rpcEndpoint;
    const devPlatform = Platform.connect({ network: "x1-localnet", signer: dev, rpcUrl });
    const playerPlatform = Platform.connect({ network: "x1-localnet", signer: player, rpcUrl });

    const gameIdStr = `opt-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    await devPlatform.registerGame({
      protocolVersion: "v0",
      id: gameIdStr,
      displayName: "Optimistic Test",
      tier: "DEMO",
      runtime: "MANAGED",
      attestationModels: ["OPTIMISTIC"],
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
    const expectedRake = Math.floor((stake * rakeBps) / 10_000);
    const expectedPayout = stake - expectedRake;

    const { matchId } = await devPlatform.createMatch({
      gameId: gameIdStr,
      seats: 1,
      stakePerSeat: stake.toString(),
      housePrize: null,
      rakeBps,
      model: "OPTIMISTIC",
      fundingDeadlineSec: 600,
      settlementDeadlineSec: 3600,
      attestor: dev.publicKey.toBase58(),
      treasury: treasury.publicKey.toBase58(),
      challengeWindowSecs: opts.challengeWindowSecs,
    });
    await playerPlatform.joinMatch({ matchId });

    const playerBefore = await provider.connection.getBalance(player.publicKey);
    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

    await devPlatform.signAndPostOutcome({
      matchId,
      gameId: gameIdStr,
      winners: [player.publicKey.toBase58()],
      payoutShares: [expectedPayout.toString()],
      replayHash: REPLAY,
      idempotencyKey: `opt-${matchId}-1`,
    });

    return { devPlatform, matchId, player, treasury, playerBefore, treasuryBefore, expectedPayout, expectedRake };
  }

  it("post transitions Live → Settled without paying out", async function () {
    this.timeout(20_000);
    // Long enough window that finalize will never race the clock.
    const { devPlatform, matchId, player, treasury, playerBefore, treasuryBefore } =
      await settledOptimisticMatch({ challengeWindowSecs: 600 });

    const settled = await devPlatform.getMatch(matchId);
    expect(settled.state).to.equal("Settled");
    expect(await provider.connection.getBalance(player.publicKey)).to.equal(playerBefore);
    expect(await provider.connection.getBalance(treasury.publicKey)).to.equal(treasuryBefore);
  });

  it("finalize before challenge window expires fails", async function () {
    this.timeout(20_000);
    const { devPlatform, matchId } = await settledOptimisticMatch({ challengeWindowSecs: 600 });

    let failed = false;
    try {
      await devPlatform.finalizeMatch({ matchId });
    } catch (_err) {
      failed = true;
    }
    expect(failed, "finalize before window should fail").to.equal(true);
  });

  it("finalize after window pays out and transitions to Paid", async function () {
    this.timeout(120_000);
    const { devPlatform, matchId, player, treasury, playerBefore, treasuryBefore, expectedPayout, expectedRake } =
      await settledOptimisticMatch({ challengeWindowSecs: 1 });

    const settled = await devPlatform.getMatch(matchId);
    expect(settled.state).to.equal("Settled");
    expect(settled.settledAt).to.be.greaterThan(0);

    // Retry finalize until the chain's own clock check passes. The chain is
    // the source of truth for when the window has elapsed; we let it tell us
    // rather than guessing from getBlockTime (which surfpool can return null
    // for) or wall time (which can drift relative to the slot clock).
    const start = Date.now();
    let finalized = false;
    let lastError: unknown;
    while (Date.now() - start < 90_000) {
      try {
        await devPlatform.finalizeMatch({ matchId });
        finalized = true;
        break;
      } catch (e) {
        lastError = e;
        if (!String(e).match(/ChallengeWindowOpen/)) throw e; // unexpected — surface immediately
        await sleep(500);
      }
    }
    expect(finalized, `finalize never landed: ${String(lastError)}`).to.equal(true);
    const paid = await devPlatform.getMatch(matchId);
    expect(paid.state).to.equal("Paid");

    const playerAfter = await provider.connection.getBalance(player.publicKey);
    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    expect(playerAfter - playerBefore).to.equal(expectedPayout);
    expect(treasuryAfter - treasuryBefore).to.equal(expectedRake);
  });

  it("rejects OPTIMISTIC match created with challenge_window_secs == 0", async () => {
    const dev = Keypair.generate();
    const treasury = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    await airdrop(treasury.publicKey, 1);

    const rpcUrl = provider.connection.rpcEndpoint;
    const devPlatform = Platform.connect({ network: "x1-localnet", signer: dev, rpcUrl });
    const gameIdStr = `opt-zw-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    await devPlatform.registerGame({
      protocolVersion: "v0",
      id: gameIdStr,
      displayName: "Optimistic Zero Window",
      tier: "DEMO",
      runtime: "MANAGED",
      attestationModels: ["OPTIMISTIC"],
      seats: { min: 1, max: 1 },
      simulator: { kind: "server", sha256: SHA },
      devPubkey: dev.publicKey.toBase58(),
      attestorPubkey: dev.publicKey.toBase58(),
      revenueReceiver: dev.publicKey.toBase58(),
      joinUrlTemplate: "https://example.test/play/{matchId}",
      metadataUri: "https://example.test/m.json",
    });

    let failed = false;
    try {
      await devPlatform.createMatch({
        gameId: gameIdStr,
        seats: 1,
        stakePerSeat: "1000000",
        housePrize: null,
        rakeBps: 300,
        model: "OPTIMISTIC",
        fundingDeadlineSec: 600,
        settlementDeadlineSec: 3600,
        attestor: dev.publicKey.toBase58(),
        treasury: treasury.publicKey.toBase58(),
        challengeWindowSecs: 0,
      });
    } catch (_err) {
      failed = true;
    }
    expect(failed, "OPTIMISTIC with zero window should be rejected").to.equal(true);
  });

  it("rejects TRUSTED match created with non-zero challenge_window_secs", async () => {
    const dev = Keypair.generate();
    const treasury = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    await airdrop(treasury.publicKey, 1);

    const rpcUrl = provider.connection.rpcEndpoint;
    const devPlatform = Platform.connect({ network: "x1-localnet", signer: dev, rpcUrl });
    const gameIdStr = `tr-w-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    await devPlatform.registerGame({
      protocolVersion: "v0",
      id: gameIdStr,
      displayName: "Trusted with Window",
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

    let failed = false;
    try {
      await devPlatform.createMatch({
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
        challengeWindowSecs: 60,
      });
    } catch (_err) {
      failed = true;
    }
    expect(failed, "TRUSTED with non-zero window should be rejected").to.equal(true);
  });
});
