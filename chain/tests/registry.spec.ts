import anchor from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { expect } from "chai";

const { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = pkg;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: anchor.Program<any> = anchor.workspace.GameRegistry;

const SHA = new Array(32).fill(0xab);

async function airdrop(to: pkg.PublicKey, lamports: number) {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

function derivePda(id: string): pkg.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), Buffer.from(id)],
    registry.programId,
  );
  return pda;
}

describe("game_registry — register_game", () => {
  it("creates a Game PDA with the supplied fields", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    const id = `g-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    const gamePda = derivePda(id);
    const attestor = Keypair.generate().publicKey;
    const revenue = Keypair.generate().publicKey;

    await registry.methods
      .registerGame({
        id,
        attestorPubkey: attestor,
        revenueReceiver: revenue,
        simulatorSha256: SHA,
        tier: { demo: {} },
        seatsMin: 1,
        seatsMax: 4,
      })
      .accounts({ game: gamePda, dev: dev.publicKey, systemProgram: SystemProgram.programId })
      .signers([dev])
      .rpc();

    const g = await registry.account.game.fetch(gamePda);
    expect(g.id).to.equal(id);
    expect(g.devPubkey.toBase58()).to.equal(dev.publicKey.toBase58());
    expect(g.attestorPubkey.toBase58()).to.equal(attestor.toBase58());
    expect(g.revenueReceiver.toBase58()).to.equal(revenue.toBase58());
    expect(g.tier).to.deep.equal({ demo: {} });
    expect(g.seatsMin).to.equal(1);
    expect(g.seatsMax).to.equal(4);
  });

  it("rejects id shorter than 3 chars", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    const id = "ab";
    const gamePda = derivePda(id);

    let failed = false;
    try {
      await registry.methods
        .registerGame({
          id,
          attestorPubkey: dev.publicKey,
          revenueReceiver: dev.publicKey,
          simulatorSha256: SHA,
          tier: { demo: {} },
          seatsMin: 1,
          seatsMax: 1,
        })
        .accounts({ game: gamePda, dev: dev.publicKey, systemProgram: SystemProgram.programId })
        .signers([dev])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "short id should be rejected").to.equal(true);
  });

  it("rejects id with invalid charset", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    const id = "BadID";
    const gamePda = derivePda(id);

    let failed = false;
    try {
      await registry.methods
        .registerGame({
          id,
          attestorPubkey: dev.publicKey,
          revenueReceiver: dev.publicKey,
          simulatorSha256: SHA,
          tier: { demo: {} },
          seatsMin: 1,
          seatsMax: 1,
        })
        .accounts({ game: gamePda, dev: dev.publicKey, systemProgram: SystemProgram.programId })
        .signers([dev])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "uppercase id should be rejected").to.equal(true);
  });

  it("rejects seats_min > seats_max", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    const id = `seats-bad-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    const gamePda = derivePda(id);

    let failed = false;
    try {
      await registry.methods
        .registerGame({
          id,
          attestorPubkey: dev.publicKey,
          revenueReceiver: dev.publicKey,
          simulatorSha256: SHA,
          tier: { demo: {} },
          seatsMin: 5,
          seatsMax: 2,
        })
        .accounts({ game: gamePda, dev: dev.publicKey, systemProgram: SystemProgram.programId })
        .signers([dev])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "seats_min > seats_max should be rejected").to.equal(true);
  });

  it("rejects re-registration of the same id", async () => {
    const dev = Keypair.generate();
    await airdrop(dev.publicKey, LAMPORTS_PER_SOL);
    const id = `dup-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    const gamePda = derivePda(id);

    const args = {
      id,
      attestorPubkey: dev.publicKey,
      revenueReceiver: dev.publicKey,
      simulatorSha256: SHA,
      tier: { demo: {} } as Record<string, Record<string, never>>,
      seatsMin: 1,
      seatsMax: 1,
    };

    await registry.methods
      .registerGame(args)
      .accounts({ game: gamePda, dev: dev.publicKey, systemProgram: SystemProgram.programId })
      .signers([dev])
      .rpc();

    let failed = false;
    try {
      await registry.methods
        .registerGame(args)
        .accounts({ game: gamePda, dev: dev.publicKey, systemProgram: SystemProgram.programId })
        .signers([dev])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed, "re-init of an existing Game PDA should be rejected").to.equal(true);
  });
});
