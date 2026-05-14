import anchor from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { expect } from "chai";

const { BN } = anchor;
const { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = pkg;

type Wallet = anchor.Wallet;
type Program<T> = anchor.Program<T>;

// Shared provider/program for all describes
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const program: Program<any> = anchor.workspace.MatchProgram;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: Program<any> = anchor.workspace.GameRegistry;

// --- helpers ---------------------------------------------------------------

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
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
    program.programId,
  );
  return pda;
}

function deriveVaultPda(matchPda: pkg.PublicKey): pkg.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), matchPda.toBuffer()],
    program.programId,
  );
  return pda;
}

async function airdrop(to: pkg.PublicKey, lamports: number): Promise<void> {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

/** Register a game once per test run; idempotent on subsequent calls. */
async function ensureRegisteredGame(opts: { id: string; attestor?: pkg.PublicKey; seatsMin?: number; seatsMax?: number }) {
  const dev = (provider.wallet as Wallet).payer;
  const attestor = opts.attestor ?? dev.publicKey;
  const gamePda = deriveGamePda(opts.id);

  const existing = await provider.connection.getAccountInfo(gamePda);
  if (existing) return { gamePda, attestor };

  await registry.methods
    .registerGame({
      id: opts.id,
      attestorPubkey: attestor,
      revenueReceiver: dev.publicKey,
      simulatorSha256: new Array(32).fill(0),
      tier: { demo: {} },
      seatsMin: opts.seatsMin ?? 1,
      seatsMax: opts.seatsMax ?? 4,
    })
    .accounts({
      game: gamePda,
      dev: dev.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([dev])
    .rpc();

  return { gamePda, attestor };
}

interface CreateMatchOpts {
  seats?: number;
  stakePerSeat?: number;
  rakeBps?: number;
  attestor?: pkg.PublicKey;
  treasury?: pkg.PublicKey;
  gameIdString?: string;
}

async function createTestMatch(opts: CreateMatchOpts = {}): Promise<{
  matchPda: pkg.PublicKey;
  vaultPda: pkg.PublicKey;
  gamePda: pkg.PublicKey;
  nonce: anchor.BN;
  stakePerSeat: number;
  rakeBps: number;
  attestor: pkg.PublicKey;
  treasury: pkg.PublicKey;
}> {
  const dev = (provider.wallet as Wallet).payer;
  const nonce = new BN(Math.floor(Math.random() * 1_000_000));
  const seats = opts.seats ?? 1;
  const stakePerSeat = opts.stakePerSeat ?? 5_000_000;
  const rakeBps = opts.rakeBps ?? 300;
  const idString = opts.gameIdString ?? `tg-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
  const { gamePda, attestor: registeredAttestor } = await ensureRegisteredGame({
    id: idString,
    attestor: opts.attestor,
    seatsMin: 1,
    seatsMax: 16,
  });
  const attestor = opts.attestor ?? registeredAttestor;
  const treasury = opts.treasury ?? Keypair.generate().publicKey;
  const matchPda = deriveMatchPda(gamePda, nonce);
  const vaultPda = deriveVaultPda(matchPda);

  await program.methods
    .createMatch({
      nonce,
      seats,
      stakePerSeat: new BN(stakePerSeat),
      rakeBps,
      fundingDeadline: new BN(nowSec() + 600),
      settlementDeadline: new BN(nowSec() + 3600),
      model: { trusted: {} },
      attestor,
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

  return { matchPda, vaultPda, gamePda, nonce, stakePerSeat, rakeBps, attestor, treasury };
}

// --- create_match ----------------------------------------------------------

describe("match_program — create_match", () => {
  it("creates a Match account with the supplied config", async () => {
    const { matchPda, gamePda } = await createTestMatch({ seats: 1, stakePerSeat: 5_000_000, rakeBps: 300 });

    const m = await program.account.match.fetch(matchPda);
    expect(m.seats).to.equal(1);
    expect(m.stakePerSeat.toNumber()).to.equal(5_000_000);
    expect(m.rakeBps).to.equal(300);
    expect(m.state).to.deep.equal({ created: {} });
    expect(m.players).to.have.lengthOf(0);
    expect(m.gameId.toBase58()).to.equal(gamePda.toBase58());
  });

  it("creates the vault PDA owned by the match program", async () => {
    const { vaultPda, matchPda } = await createTestMatch();
    const info = await provider.connection.getAccountInfo(vaultPda);
    expect(info, "vault should exist after create_match").to.not.equal(null);
    expect(info!.owner.toBase58()).to.equal(program.programId.toBase58());

    const v = await program.account.vault.fetch(vaultPda);
    expect(v.matchAccount.toBase58()).to.equal(matchPda.toBase58());
  });

  it("rejects seats = 0", async () => {
    const dev = (provider.wallet as Wallet).payer;
    const { gamePda } = await ensureRegisteredGame({ id: "seats-zero-game" });
    const nonce = new BN(999_001);
    const matchPda = deriveMatchPda(gamePda, nonce);
    const vaultPda = deriveVaultPda(matchPda);

    let failed = false;
    try {
      await program.methods
        .createMatch({
          nonce,
          seats: 0,
          stakePerSeat: new BN(5_000_000),
          rakeBps: 300,
          fundingDeadline: new BN(nowSec() + 600),
          settlementDeadline: new BN(nowSec() + 3600),
          model: { trusted: {} },
          attestor: dev.publicKey,
          treasury: Keypair.generate().publicKey,
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
    } catch (_err) {
      failed = true;
    }
    expect(failed, "create_match should reject seats = 0").to.equal(true);
  });
});

// --- join_match ------------------------------------------------------------

describe("match_program — join_match", () => {
  it("first join: appends player, transfers stake to vault, state = Funded", async () => {
    const { matchPda, vaultPda, stakePerSeat } = await createTestMatch({ seats: 2, stakePerSeat: 10_000_000 });
    const playerA = Keypair.generate();
    await airdrop(playerA.publicKey, LAMPORTS_PER_SOL);

    const vaultBefore = await provider.connection.getBalance(vaultPda);

    await program.methods
      .joinMatch()
      .accounts({
        matchAccount: matchPda,
        vault: vaultPda,
        player: playerA.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([playerA])
      .rpc();

    const m = await program.account.match.fetch(matchPda);
    expect(m.players.map((p: pkg.PublicKey) => p.toBase58())).to.deep.equal([playerA.publicKey.toBase58()]);
    expect(m.state).to.deep.equal({ funded: {} });

    const vaultAfter = await provider.connection.getBalance(vaultPda);
    expect(vaultAfter - vaultBefore).to.equal(stakePerSeat);
  });

  it("filling all seats transitions state to Live", async () => {
    const { matchPda, vaultPda } = await createTestMatch({ seats: 2, stakePerSeat: 1_000_000 });
    const playerA = Keypair.generate();
    const playerB = Keypair.generate();
    await airdrop(playerA.publicKey, LAMPORTS_PER_SOL);
    await airdrop(playerB.publicKey, LAMPORTS_PER_SOL);

    await program.methods.joinMatch().accounts({
      matchAccount: matchPda, vault: vaultPda, player: playerA.publicKey, systemProgram: SystemProgram.programId,
    }).signers([playerA]).rpc();
    await program.methods.joinMatch().accounts({
      matchAccount: matchPda, vault: vaultPda, player: playerB.publicKey, systemProgram: SystemProgram.programId,
    }).signers([playerB]).rpc();

    const m = await program.account.match.fetch(matchPda);
    expect(m.players.length).to.equal(2);
    expect(m.state).to.deep.equal({ live: {} });
  });

  it("rejects double-join by the same player", async () => {
    const { matchPda, vaultPda } = await createTestMatch({ seats: 2, stakePerSeat: 1_000_000 });
    const playerA = Keypair.generate();
    await airdrop(playerA.publicKey, LAMPORTS_PER_SOL);

    await program.methods.joinMatch().accounts({
      matchAccount: matchPda, vault: vaultPda, player: playerA.publicKey, systemProgram: SystemProgram.programId,
    }).signers([playerA]).rpc();

    let failed = false;
    try {
      await program.methods.joinMatch().accounts({
        matchAccount: matchPda, vault: vaultPda, player: playerA.publicKey, systemProgram: SystemProgram.programId,
      }).signers([playerA]).rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "second join by the same player should fail").to.equal(true);
  });

  it("rejects join after match is Live", async () => {
    const { matchPda, vaultPda } = await createTestMatch({ seats: 1, stakePerSeat: 1_000_000 });
    const playerA = Keypair.generate();
    const playerB = Keypair.generate();
    await airdrop(playerA.publicKey, LAMPORTS_PER_SOL);
    await airdrop(playerB.publicKey, LAMPORTS_PER_SOL);

    await program.methods.joinMatch().accounts({
      matchAccount: matchPda, vault: vaultPda, player: playerA.publicKey, systemProgram: SystemProgram.programId,
    }).signers([playerA]).rpc();

    let failed = false;
    try {
      await program.methods.joinMatch().accounts({
        matchAccount: matchPda, vault: vaultPda, player: playerB.publicKey, systemProgram: SystemProgram.programId,
      }).signers([playerB]).rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "joining a Live match should fail").to.equal(true);
  });
});

// --- post_outcome (TRUSTED) -----------------------------------------------

describe("match_program — post_outcome (TRUSTED)", () => {
  const REPLAY_HASH = new Array(32).fill(0x42); // [u8; 32]

  async function fundedSoloMatch(stake = 5_000_000, rakeBps = 300) {
    const ctx = await createTestMatch({ seats: 1, stakePerSeat: stake, rakeBps });
    const player = Keypair.generate();
    await airdrop(player.publicKey, LAMPORTS_PER_SOL);
    await program.methods.joinMatch().accounts({
      matchAccount: ctx.matchPda, vault: ctx.vaultPda, player: player.publicKey, systemProgram: SystemProgram.programId,
    }).signers([player]).rpc();
    return { ...ctx, player };
  }

  it("settles a Live match: pays winner, pays treasury, state → Paid", async () => {
    const dev = (provider.wallet as Wallet).payer;
    const { matchPda, vaultPda, treasury, player, stakePerSeat, rakeBps } = await fundedSoloMatch();
    const expectedRake = Math.floor((stakePerSeat * rakeBps) / 10_000);
    const expectedPayout = stakePerSeat - expectedRake;

    // The treasury account must exist as a system account before lamports can
    // land on it via direct lamport-borrow. Airdrop a single lamport to bring
    // it into existence; the rake credit accumulates on top.
    await airdrop(treasury, 1);

    const winnerBefore = await provider.connection.getBalance(player.publicKey);
    const treasuryBefore = await provider.connection.getBalance(treasury);

    await program.methods
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

    const m = await program.account.match.fetch(matchPda);
    expect(m.state).to.deep.equal({ paid: {} });
    expect(m.outcome.rake.toNumber()).to.equal(expectedRake);
    expect(m.outcome.winners).to.have.lengthOf(1);
    expect(m.outcome.winners[0].pubkey.toBase58()).to.equal(player.publicKey.toBase58());
    expect(m.outcome.winners[0].payout.toNumber()).to.equal(expectedPayout);

    const winnerAfter = await provider.connection.getBalance(player.publicKey);
    const treasuryAfter = await provider.connection.getBalance(treasury);
    expect(winnerAfter - winnerBefore).to.equal(expectedPayout);
    expect(treasuryAfter - treasuryBefore).to.equal(expectedRake);
  });

  it("rejects post_outcome from a signer that isn't the attestor", async () => {
    const { matchPda, vaultPda, treasury, player } = await fundedSoloMatch();
    const imposter = Keypair.generate();
    await airdrop(imposter.publicKey, LAMPORTS_PER_SOL);
    await airdrop(treasury, 1);

    let failed = false;
    try {
      await program.methods
        .postOutcome({ payouts: [new BN(4_850_000)], replayHash: REPLAY_HASH })
        .accounts({
          matchAccount: matchPda,
          vault: vaultPda,
          attestor: imposter.publicKey,
          treasury,
        })
        .remainingAccounts([{ pubkey: player.publicKey, isSigner: false, isWritable: true }])
        .signers([imposter])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "non-attestor signer should be rejected").to.equal(true);
  });

  it("rejects payout that doesn't exactly equal pot − rake", async () => {
    const dev = (provider.wallet as Wallet).payer;
    const { matchPda, vaultPda, treasury, player } = await fundedSoloMatch();
    await airdrop(treasury, 1);

    let failed = false;
    try {
      await program.methods
        .postOutcome({ payouts: [new BN(4_000_000)], replayHash: REPLAY_HASH }) // wrong by 850k
        .accounts({
          matchAccount: matchPda,
          vault: vaultPda,
          attestor: dev.publicKey,
          treasury,
        })
        .remainingAccounts([{ pubkey: player.publicKey, isSigner: false, isWritable: true }])
        .signers([dev])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "incorrect payout math should be rejected").to.equal(true);
  });

  it("multi-winner: pays each winner and the treasury", async () => {
    const dev = (provider.wallet as Wallet).payer;
    // 2-seat match. Both players win on a draw; pot splits 50/50.
    const { matchPda, vaultPda, treasury, rakeBps } = await createTestMatch({
      seats: 2,
      stakePerSeat: 4_000_000,
      rakeBps: 300,
    });
    const playerA = Keypair.generate();
    const playerB = Keypair.generate();
    await airdrop(playerA.publicKey, LAMPORTS_PER_SOL);
    await airdrop(playerB.publicKey, LAMPORTS_PER_SOL);
    await airdrop(treasury, 1);

    await program.methods.joinMatch().accounts({
      matchAccount: matchPda, vault: vaultPda, player: playerA.publicKey, systemProgram: SystemProgram.programId,
    }).signers([playerA]).rpc();
    await program.methods.joinMatch().accounts({
      matchAccount: matchPda, vault: vaultPda, player: playerB.publicKey, systemProgram: SystemProgram.programId,
    }).signers([playerB]).rpc();

    const pot = 4_000_000 * 2;
    const rake = Math.floor((pot * rakeBps) / 10_000);
    const distributable = pot - rake;
    const halfA = Math.floor(distributable / 2);
    const halfB = distributable - halfA;

    const aBefore = await provider.connection.getBalance(playerA.publicKey);
    const bBefore = await provider.connection.getBalance(playerB.publicKey);
    const treasuryBefore = await provider.connection.getBalance(treasury);

    await program.methods
      .postOutcome({
        payouts: [new BN(halfA), new BN(halfB)],
        replayHash: REPLAY_HASH,
      })
      .accounts({
        matchAccount: matchPda, vault: vaultPda, attestor: dev.publicKey, treasury,
      })
      .remainingAccounts([
        { pubkey: playerA.publicKey, isSigner: false, isWritable: true },
        { pubkey: playerB.publicKey, isSigner: false, isWritable: true },
      ])
      .signers([dev])
      .rpc();

    const m = await program.account.match.fetch(matchPda);
    expect(m.state).to.deep.equal({ paid: {} });
    expect(m.outcome.winners).to.have.lengthOf(2);
    expect(m.outcome.winners[0].pubkey.toBase58()).to.equal(playerA.publicKey.toBase58());
    expect(m.outcome.winners[0].payout.toNumber()).to.equal(halfA);
    expect(m.outcome.winners[1].pubkey.toBase58()).to.equal(playerB.publicKey.toBase58());
    expect(m.outcome.winners[1].payout.toNumber()).to.equal(halfB);

    const aAfter = await provider.connection.getBalance(playerA.publicKey);
    const bAfter = await provider.connection.getBalance(playerB.publicKey);
    const treasuryAfter = await provider.connection.getBalance(treasury);
    expect(aAfter - aBefore).to.equal(halfA);
    expect(bAfter - bBefore).to.equal(halfB);
    expect(treasuryAfter - treasuryBefore).to.equal(rake);
  });

  it("rejects post_outcome before match is Live (still Created)", async () => {
    const dev = (provider.wallet as Wallet).payer;
    // Don't fund — match stays in Created.
    const { matchPda, vaultPda, treasury } = await createTestMatch({
      seats: 2, stakePerSeat: 1_000_000, rakeBps: 300,
    });
    const fakeWinner = Keypair.generate().publicKey;
    await airdrop(treasury, 1);

    let failed = false;
    try {
      await program.methods
        .postOutcome({ payouts: [new BN(970_000)], replayHash: REPLAY_HASH })
        .accounts({
          matchAccount: matchPda,
          vault: vaultPda,
          attestor: dev.publicKey,
          treasury,
        })
        .remainingAccounts([{ pubkey: fakeWinner, isSigner: false, isWritable: true }])
        .signers([dev])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "post_outcome on non-Live match should be rejected").to.equal(true);
  });
});
