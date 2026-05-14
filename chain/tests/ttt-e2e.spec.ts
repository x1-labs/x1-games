import { anchor, web3 as pkg } from "./_anchor.ts";
import { expect } from "chai";
import { Platform } from "@x1-labs/games-sdk";
import { TttGameServer } from "@x1-labs/sample-tic-tac-toe";

// The killer end-to-end test on chain: real tic-tac-toe game, real on-chain
// settlement, real lamport movement, real XP credit. Drives the full v0
// production path through the public SDK surface.

const { Keypair, LAMPORTS_PER_SOL } = pkg;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

async function airdrop(to: pkg.PublicKey, lamports: number) {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

const SHA_HEX = "0x" + "4f".repeat(32);

describe("Tic-Tac-Toe — end-to-end on chain", () => {
  it("registers game, plays a PvP match, settles on-chain, credits XP", async function () {
    // PvP match: dev (creator + attestor + treasury) + two players.
    const devKp = Keypair.generate();
    const playerAKp = Keypair.generate();
    const playerBKp = Keypair.generate();
    const treasuryKp = Keypair.generate();
    await airdrop(devKp.publicKey, 3 * LAMPORTS_PER_SOL);
    await airdrop(playerAKp.publicKey, 2 * LAMPORTS_PER_SOL);
    await airdrop(playerBKp.publicKey, 2 * LAMPORTS_PER_SOL);
    await airdrop(treasuryKp.publicKey, 1);

    const rpcUrl = provider.connection.rpcEndpoint;
    const dev = Platform.connect({ network: "x1-localnet", signer: devKp, rpcUrl });
    const playerA = Platform.connect({ network: "x1-localnet", signer: playerAKp, rpcUrl });
    const playerB = Platform.connect({ network: "x1-localnet", signer: playerBKp, rpcUrl });

    // The game server runs on the dev's Platform — it's the canonical sim and
    // attestor (TRUSTED model).
    const server = new TttGameServer({ platform: dev });

    // 1. Register tic-tac-toe on chain.
    await dev.registerGame({
      protocolVersion: "v0",
      id: "tic-tac-toe",
      displayName: "Tic-Tac-Toe",
      tier: "DEMO",
      runtime: "MANAGED",
      attestationModels: ["TRUSTED"],
      seats: { min: 2, max: 2 },
      simulator: { kind: "server", sha256: SHA_HEX },
      devPubkey: dev.pubkey,
      attestorPubkey: dev.pubkey,
      revenueReceiver: dev.pubkey,
      joinUrlTemplate: "https://ttt.x1-labs.dev/play/{matchId}",
      metadataUri: "https://ttt.x1-labs.dev/metadata.json",
    });

    // 2. Create a 2-seat match. Stake 0.005 SOL each (10M lamports pot).
    const stakePerSeat = 5_000_000;
    const rakeBps = 300;
    const pot = stakePerSeat * 2;
    const expectedRake = Math.floor((pot * rakeBps) / 10_000);
    const expectedPayout = pot - expectedRake;

    const { matchId } = await dev.createMatch({
      gameId: "tic-tac-toe",
      seats: 2,
      stakePerSeat: stakePerSeat.toString(),
      housePrize: null,
      rakeBps,
      model: "TRUSTED",
      fundingDeadlineSec: 600,
      settlementDeadlineSec: 3600,
      attestor: dev.pubkey,
      treasury: treasuryKp.publicKey.toBase58(),
    });

    // 3. Both players join. Order matters: first joiner is X, second is O.
    await playerA.joinMatch({ matchId });
    await playerB.joinMatch({ matchId });

    // 4. Attach the match to the server (no on-chain event push in v0).
    await server.attachMatch(matchId);

    // 5. Capture balances pre-settlement.
    const aBefore = await provider.connection.getBalance(playerAKp.publicKey);
    const treasuryBefore = await provider.connection.getBalance(treasuryKp.publicKey);

    // 6. Play out: A wins top row (cells 0,1,2). B plays cells 3,4 in between.
    server.submitMove({ matchId, player: playerA.pubkey, cell: 0 });
    server.submitMove({ matchId, player: playerB.pubkey, cell: 3 });
    server.submitMove({ matchId, player: playerA.pubkey, cell: 1 });
    server.submitMove({ matchId, player: playerB.pubkey, cell: 4 });
    await server.submitMove({ matchId, player: playerA.pubkey, cell: 2 });
    // The async return ensures the settlement tx has landed.

    // 7. Verify on-chain Match transitioned to Paid with the right outcome.
    const m = await dev.getMatch(matchId);
    expect(m.state).to.equal("Paid");
    expect(m.outcome).to.not.equal(undefined);
    expect(m.outcome!.winners).to.deep.equal([playerA.pubkey]);
    expect(m.outcome!.payoutShares).to.deep.equal([expectedPayout.toString()]);

    // 8. Verify lamports actually moved.
    const aAfter = await provider.connection.getBalance(playerAKp.publicKey);
    const treasuryAfter = await provider.connection.getBalance(treasuryKp.publicKey);
    expect(aAfter - aBefore).to.equal(expectedPayout);
    expect(treasuryAfter - treasuryBefore).to.equal(expectedRake);

    // 9. Credit XP for both players. Winner gets 100, loser gets 25.
    await dev.creditXp({ matchId, player: playerA.pubkey });
    await dev.creditXp({ matchId, player: playerB.pubkey });

    const xpA = await dev.getXp({ gameId: "tic-tac-toe", player: playerA.pubkey });
    const xpB = await dev.getXp({ gameId: "tic-tac-toe", player: playerB.pubkey });
    expect(xpA.amount).to.equal("100");
    expect(xpB.amount).to.equal("25");
  });

});

// Note: TTT draws result in a multi-winner outcome (pot split). The chain's
// post_outcome v0 only supports single-winner — see SolanaBackend.signAndPostOutcome.
// The stub-based TTT tests cover the draw path; an on-chain draw test is
// deferred until the chain supports multi-winner outcomes.
