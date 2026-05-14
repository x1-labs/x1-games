import anchor from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { expect } from "chai";
import { Platform } from "@x1-labs/games-sdk";

// End-to-end test of the SolanaBackend through the public SDK surface,
// running against the local validator that anchor test spins up.
//
// What this proves:
// - SDK's createMatch builds a valid Anchor instruction the deployed
//   match_program accepts.
// - joinMatch transfers stake and updates state correctly.
// - signAndPostOutcome (TRUSTED) settles the match and pays out lamports.
// - getMatch reads back the on-chain truth correctly.

const { Keypair, LAMPORTS_PER_SOL } = pkg;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const REPLAY_HASH_HEX = "0x" + "42".repeat(32);

async function airdrop(to: pkg.PublicKey, lamports: number): Promise<void> {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

describe("SDK SolanaBackend — end-to-end against deployed match_program", () => {
  it("registerGame → createMatch → joinMatch → signAndPostOutcome flows through to on-chain state", async () => {
    const devKp = Keypair.generate();
    const playerKp = Keypair.generate();
    const treasuryKp = Keypair.generate();
    await airdrop(devKp.publicKey, 2 * LAMPORTS_PER_SOL);
    await airdrop(playerKp.publicKey, 2 * LAMPORTS_PER_SOL);
    await airdrop(treasuryKp.publicKey, 1);

    const rpcUrl = provider.connection.rpcEndpoint;
    const dev = Platform.connect({ network: "x1-localnet", signer: devKp, rpcUrl });
    const player = Platform.connect({ network: "x1-localnet", signer: playerKp, rpcUrl });

    expect(dev.pubkey).to.equal(devKp.publicKey.toBase58());
    expect(player.pubkey).to.equal(playerKp.publicKey.toBase58());

    // Register the game on-chain.
    const gameIdStr = `sdk-test-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    const registered = await dev.registerGame({
      protocolVersion: "v0",
      id: gameIdStr,
      displayName: "SDK Test Game",
      tier: "DEMO",
      runtime: "MANAGED",
      attestationModels: ["TRUSTED"],
      seats: { min: 1, max: 4 },
      simulator: { kind: "server", sha256: "0x" + "33".repeat(32) },
      devPubkey: dev.pubkey,
      attestorPubkey: dev.pubkey,
      revenueReceiver: dev.pubkey,
      joinUrlTemplate: "https://example.test/play/{matchId}",
      metadataUri: "https://example.test/m.json",
    });
    expect(registered.gameId).to.equal(gameIdStr);

    const stake = 10_000_000;
    const rakeBps = 300;
    const expectedRake = Math.floor((stake * rakeBps) / 10_000);
    const expectedPayout = stake - expectedRake;

    const { matchId } = await dev.createMatch({
      gameId: gameIdStr,
      seats: 1,
      stakePerSeat: stake.toString(),
      housePrize: null,
      rakeBps,
      model: "TRUSTED",
      fundingDeadlineSec: 600,
      settlementDeadlineSec: 3600,
      attestor: dev.pubkey,
      treasury: treasuryKp.publicKey.toBase58(),
    });
    expect(matchId).to.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    const mAfterCreate = await dev.getMatch(matchId);
    expect(mAfterCreate.state).to.equal("Created");

    const playerJoinResult = await player.joinMatch({ matchId });
    expect(playerJoinResult.state).to.equal("Live");

    const mAfterJoin = await dev.getMatch(matchId);
    expect(mAfterJoin.state).to.equal("Live");
    expect(mAfterJoin.players).to.have.lengthOf(1);
    expect(mAfterJoin.players[0]).to.equal(player.pubkey);

    // Capture pre-settlement balances.
    const playerBefore = await provider.connection.getBalance(playerKp.publicKey);
    const treasuryBefore = await provider.connection.getBalance(treasuryKp.publicKey);

    await dev.signAndPostOutcome({
      matchId,
      gameId: gameIdStr,
      winners: [player.pubkey],
      payoutShares: [expectedPayout.toString()],
      replayHash: REPLAY_HASH_HEX,
      idempotencyKey: `sdk-test-${matchId}-outcome`,
    });

    const mAfterSettle = await dev.getMatch(matchId);
    expect(mAfterSettle.state).to.equal("Paid"); // TRUSTED settles+pays atomically
    expect(mAfterSettle.outcome).to.not.equal(undefined);
    expect(mAfterSettle.outcome!.winners).to.deep.equal([player.pubkey]);
    expect(mAfterSettle.outcome!.payoutShares).to.deep.equal([expectedPayout.toString()]);
    expect(mAfterSettle.outcome!.replayHash).to.equal(REPLAY_HASH_HEX);

    const playerAfter = await provider.connection.getBalance(playerKp.publicKey);
    const treasuryAfter = await provider.connection.getBalance(treasuryKp.publicKey);
    expect(playerAfter - playerBefore).to.equal(expectedPayout);
    expect(treasuryAfter - treasuryBefore).to.equal(expectedRake);

    // XP credit (winner gets WINNER_XP = 100).
    const credit = await dev.creditXp({ matchId, player: player.pubkey });
    expect(credit.amount).to.equal("100");
    expect(credit.balance).to.equal("100");

    const xp = await dev.getXp({ gameId: gameIdStr, player: player.pubkey });
    expect(xp.amount).to.equal("100");
    expect(xp.player).to.equal(player.pubkey);
  });

  it("registerGame is idempotent — re-registering the same id is a no-op", async () => {
    const kp = Keypair.generate();
    await airdrop(kp.publicKey, LAMPORTS_PER_SOL);
    const p = Platform.connect({
      network: "x1-localnet",
      signer: kp,
      rpcUrl: provider.connection.rpcEndpoint,
    });
    const reg = {
      protocolVersion: "v0" as const,
      id: `idem-${Math.floor(Math.random() * 1_000_000).toString(36)}`,
      displayName: "Idem Test",
      tier: "DEMO" as const,
      runtime: "MANAGED" as const,
      attestationModels: ["TRUSTED" as const],
      seats: { min: 1, max: 2 },
      simulator: { kind: "server" as const, sha256: "0x" + "11".repeat(32) },
      devPubkey: kp.publicKey.toBase58(),
      attestorPubkey: kp.publicKey.toBase58(),
      revenueReceiver: kp.publicKey.toBase58(),
      joinUrlTemplate: "https://example.test/play/{matchId}",
      metadataUri: "https://example.test/m.json",
    };
    const a = await p.registerGame(reg);
    const b = await p.registerGame(reg);
    expect(b.gameId).to.equal(a.gameId);
    expect(b.attestorPubkey).to.equal(a.attestorPubkey);
  });
});
