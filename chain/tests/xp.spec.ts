import { anchor, web3 as pkg } from "./_anchor.ts";
import { expect } from "chai";

const { BN } = anchor;
const { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = pkg;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const matchProgram: anchor.Program<any> = anchor.workspace.MatchProgram;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: anchor.Program<any> = anchor.workspace.GameRegistry;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xp: anchor.Program<any> = anchor.workspace.XpLedger;

const WINNER_XP = 100;
const LOSER_XP = 25;
const REPLAY_HASH = new Array(32).fill(0x42);

async function airdrop(to: pkg.PublicKey, lamports: number) {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

function deriveGamePda(id: string): pkg.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), Buffer.from(id)],
    registry.programId,
  );
  return pda;
}
function deriveMatchPda(gamePda: pkg.PublicKey, nonce: anchor.BN): pkg.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("match"), gamePda.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
    matchProgram.programId,
  );
  return pda;
}
function deriveVaultPda(matchPda: pkg.PublicKey): pkg.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), matchPda.toBuffer()],
    matchProgram.programId,
  );
  return pda;
}
function deriveXpBalancePda(game: pkg.PublicKey, player: pkg.PublicKey): pkg.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("xp"), game.toBuffer(), player.toBuffer()],
    xp.programId,
  );
  return pda;
}
function deriveReceiptPda(matchPda: pkg.PublicKey, player: pkg.PublicKey): pkg.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("xp-receipt"), matchPda.toBuffer(), player.toBuffer()],
    xp.programId,
  );
  return pda;
}

interface SettledMatchSetup {
  gamePda: pkg.PublicKey;
  matchPda: pkg.PublicKey;
  player: pkg.PublicKey;
  treasury: pkg.PublicKey;
}

/** Register a game, create a 1-seat match, fund and settle it. */
async function settledSoloMatch(idString: string): Promise<SettledMatchSetup> {
  const dev = (provider.wallet as anchor.Wallet).payer;
  const gamePda = deriveGamePda(idString);
  await registry.methods
    .registerGame({
      id: idString,
      attestorPubkey: dev.publicKey,
      revenueReceiver: dev.publicKey,
      simulatorSha256: new Array(32).fill(0),
      tier: { demo: {} },
      seatsMin: 1,
      seatsMax: 1,
    })
    .accounts({ game: gamePda, dev: dev.publicKey, systemProgram: SystemProgram.programId })
    .signers([dev])
    .rpc();

  const nonce = new BN(Math.floor(Math.random() * 1_000_000));
  const matchPda = deriveMatchPda(gamePda, nonce);
  const vaultPda = deriveVaultPda(matchPda);
  const treasury = Keypair.generate().publicKey;
  await airdrop(treasury, 1);
  const stake = 5_000_000;
  const rakeBps = 300;

  await matchProgram.methods
    .createMatch({
      nonce,
      seats: 1,
      stakePerSeat: new BN(stake),
      rakeBps,
      fundingDeadline: new BN(Math.floor(Date.now() / 1000) + 600),
      settlementDeadline: new BN(Math.floor(Date.now() / 1000) + 3600),
      model: { trusted: {} },
      attestor: dev.publicKey,
      treasury,
      challengeWindowSecs: 0,
    })
    .accounts({
      game: gamePda,
      matchAccount: matchPda,
      vault: vaultPda,
      creator: dev.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([dev])
    .rpc();

  const player = Keypair.generate();
  await airdrop(player.publicKey, LAMPORTS_PER_SOL);
  await matchProgram.methods
    .joinMatch()
    .accounts({
      matchAccount: matchPda,
      vault: vaultPda,
      player: player.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([player])
    .rpc();

  const expectedRake = Math.floor((stake * rakeBps) / 10_000);
  const expectedPayout = stake - expectedRake;
  await matchProgram.methods
    .postOutcome({ payouts: [new BN(expectedPayout)], replayHash: REPLAY_HASH })
    .accounts({
      matchAccount: matchPda,
      vault: vaultPda,
      attestor: dev.publicKey,
      treasury,
    })
    .remainingAccounts([{ pubkey: player.publicKey, isSigner: false, isWritable: true }])
    .signers([dev])
    .rpc();

  return { gamePda, matchPda, player: player.publicKey, treasury };
}

describe("xp_ledger — credit_xp", () => {
  it("credits the winner with WINNER_XP", async () => {
    const dev = (provider.wallet as anchor.Wallet).payer;
    const { gamePda, matchPda, player } = await settledSoloMatch(
      `xp-win-${Math.floor(Math.random() * 1_000_000).toString(36)}`,
    );
    const xpBalance = deriveXpBalancePda(gamePda, player);
    const receipt = deriveReceiptPda(matchPda, player);

    await xp.methods
      .creditXp()
      .accounts({
        matchAccount: matchPda,
        player,
        xpBalance,
        creditReceipt: receipt,
        payer: dev.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([dev])
      .rpc();

    const b = await xp.account.xpBalance.fetch(xpBalance);
    expect(b.amount.toNumber()).to.equal(WINNER_XP);
    expect(b.player.toBase58()).to.equal(player.toBase58());
    expect(b.game.toBase58()).to.equal(gamePda.toBase58());
  });

  it("rejects double-credit for the same (match, player)", async () => {
    const dev = (provider.wallet as anchor.Wallet).payer;
    const { gamePda, matchPda, player } = await settledSoloMatch(
      `xp-dup-${Math.floor(Math.random() * 1_000_000).toString(36)}`,
    );
    const xpBalance = deriveXpBalancePda(gamePda, player);
    const receipt = deriveReceiptPda(matchPda, player);

    await xp.methods
      .creditXp()
      .accounts({
        matchAccount: matchPda, player, xpBalance, creditReceipt: receipt,
        payer: dev.publicKey, systemProgram: SystemProgram.programId,
      })
      .signers([dev])
      .rpc();

    let failed = false;
    try {
      await xp.methods
        .creditXp()
        .accounts({
          matchAccount: matchPda, player, xpBalance, creditReceipt: receipt,
          payer: dev.publicKey, systemProgram: SystemProgram.programId,
        })
        .signers([dev])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "second credit_xp for the same (match,player) should fail").to.equal(true);
  });

  it("rejects credit for a non-participant", async () => {
    const dev = (provider.wallet as anchor.Wallet).payer;
    const { gamePda, matchPda } = await settledSoloMatch(
      `xp-imp-${Math.floor(Math.random() * 1_000_000).toString(36)}`,
    );
    const stranger = Keypair.generate().publicKey;
    const xpBalance = deriveXpBalancePda(gamePda, stranger);
    const receipt = deriveReceiptPda(matchPda, stranger);

    let failed = false;
    try {
      await xp.methods
        .creditXp()
        .accounts({
          matchAccount: matchPda, player: stranger, xpBalance, creditReceipt: receipt,
          payer: dev.publicKey, systemProgram: SystemProgram.programId,
        })
        .signers([dev])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "credit for a non-participant should fail").to.equal(true);
  });

  it("XP balance accumulates across two settled matches for the same game/player", async () => {
    // First match: register + settle as winner.
    const dev = (provider.wallet as anchor.Wallet).payer;
    const idString = `xp-acc-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    const setup1 = await settledSoloMatch(idString);
    const player = setup1.player;
    const xpBalance = deriveXpBalancePda(setup1.gamePda, player);
    const receipt1 = deriveReceiptPda(setup1.matchPda, player);

    await xp.methods
      .creditXp()
      .accounts({
        matchAccount: setup1.matchPda, player, xpBalance, creditReceipt: receipt1,
        payer: dev.publicKey, systemProgram: SystemProgram.programId,
      })
      .signers([dev])
      .rpc();

    // Second match against the same game id — different nonce, different match.
    // We can't reuse settledSoloMatch since that re-registers the game; do it inline.
    const gamePda = setup1.gamePda;
    const nonce = new BN(Math.floor(Math.random() * 1_000_000) + 1_000_001);
    const matchPda2 = deriveMatchPda(gamePda, nonce);
    const vaultPda2 = deriveVaultPda(matchPda2);
    const treasury2 = Keypair.generate().publicKey;
    await airdrop(treasury2, 1);

    await matchProgram.methods
      .createMatch({
        nonce,
        seats: 1,
        stakePerSeat: new BN(5_000_000),
        rakeBps: 300,
        fundingDeadline: new BN(Math.floor(Date.now() / 1000) + 600),
        settlementDeadline: new BN(Math.floor(Date.now() / 1000) + 3600),
        model: { trusted: {} },
        attestor: dev.publicKey,
        treasury: treasury2,
        challengeWindowSecs: 0,
      })
      .accounts({
        game: gamePda, matchAccount: matchPda2, vault: vaultPda2,
        creator: dev.publicKey, systemProgram: SystemProgram.programId,
      })
      .signers([dev])
      .rpc();

    // Same player joins and we settle as winner again.
    const playerKp = Keypair.generate();
    await airdrop(playerKp.publicKey, LAMPORTS_PER_SOL);
    // Use a fresh player keypair (PvP isn't required, just need a participant)
    await matchProgram.methods.joinMatch().accounts({
      matchAccount: matchPda2, vault: vaultPda2, player: playerKp.publicKey, systemProgram: SystemProgram.programId,
    }).signers([playerKp]).rpc();
    const expectedPayout = 5_000_000 - 150_000;
    await matchProgram.methods
      .postOutcome({ payouts: [new BN(expectedPayout)], replayHash: REPLAY_HASH })
      .accounts({
        matchAccount: matchPda2, vault: vaultPda2, attestor: dev.publicKey, treasury: treasury2,
      })
      .remainingAccounts([{ pubkey: playerKp.publicKey, isSigner: false, isWritable: true }])
      .signers([dev]).rpc();

    const xpBalance2 = deriveXpBalancePda(gamePda, playerKp.publicKey);
    const receipt2 = deriveReceiptPda(matchPda2, playerKp.publicKey);
    await xp.methods.creditXp().accounts({
      matchAccount: matchPda2, player: playerKp.publicKey, xpBalance: xpBalance2, creditReceipt: receipt2,
      payer: dev.publicKey, systemProgram: SystemProgram.programId,
    }).signers([dev]).rpc();

    const b1 = await xp.account.xpBalance.fetch(xpBalance);
    const b2 = await xp.account.xpBalance.fetch(xpBalance2);
    expect(b1.amount.toNumber()).to.equal(WINNER_XP);
    expect(b2.amount.toNumber()).to.equal(WINNER_XP);
    // Two different players, two separate balances under the same game.
    expect(b1.player.toBase58()).to.not.equal(b2.player.toBase58());
    expect(b1.game.toBase58()).to.equal(b2.game.toBase58());
  });
});
