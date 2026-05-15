// Real on-chain backend. Talks to the deployed Match program via Anchor.
//
// v0 coverage: createMatch, joinMatch, signAndPostOutcome (TRUSTED), getMatch.
// registerGame and subscribeMatchStart throw — Game Registry program is a stub
// and the chain has no event-push for now.

import { createHash } from "node:crypto";
import anchor from "@coral-xyz/anchor";
import web3 from "@solana/web3.js";
import {
  MatchStart,
  OutcomeBody,
  OutcomeEnvelope,
  getDefaultReplayStore,
  type GameRegistration,
  type GameId,
  type MatchId,
  type Pubkey,
  type Hash,
} from "@x1-labs/games-protocol";
import matchIdlJson from "./idl/match_program.json" with { type: "json" };
import gameRegistryIdlJson from "./idl/game_registry.json" with { type: "json" };
import xpLedgerIdlJson from "./idl/xp_ledger.json" with { type: "json" };
import type {
  CreateMatchInput,
  JoinMatchInput,
  SignAndPostInput,
  MatchView,
  MatchPhase,
  CreditXpInput,
  GetXpInput,
  XpView,
  GameView,
  ListMatchesInput,
  FinalizeMatchInput,
  UploadReplayInput,
  UploadReplayResult,
  GetReplayInput,
  ReplayView,
} from "./stub.ts";

const { BN, AnchorProvider, Program, Wallet } = anchor;
const { Connection, PublicKey, SystemProgram } = web3;

const MATCH_PROGRAM_ID = new PublicKey("kPnK69DwUAmEobyLiWNNmra6STdJLFszJxc314XkEKb");
const GAME_REGISTRY_PROGRAM_ID = new PublicKey("92NzjeGS2kEuLw53vAvox6eFdNfT2VoSTrSX4uGTHKbS");
const XP_LEDGER_PROGRAM_ID = new PublicKey("E4ccwzzHoLeziC4S7so55etspU6Ag6zrGNERKhSuaD74");

// ---------------------------------------------------------------------------

/** Browser-wallet shape (Phantom, Solflare, Backpack, @solana/wallet-adapter).
 *  Only exposes a pubkey + sign methods — no raw secret key. Matches Anchor's
 *  `Wallet` interface so it plugs into AnchorProvider as-is. */
export interface WalletLikeSigner {
  publicKey: web3.PublicKey;
  signTransaction<T extends web3.Transaction | web3.VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends web3.Transaction | web3.VersionedTransaction>(txs: T[]): Promise<T[]>;
}

/** Either a raw Keypair (server-side / tests) or a wallet-adapter (browser). */
export type SolanaSigner = web3.Keypair | WalletLikeSigner;

function isKeypair(s: SolanaSigner): s is web3.Keypair {
  return "secretKey" in s && (s as web3.Keypair).secretKey instanceof Uint8Array;
}

export interface SolanaBackendOptions {
  rpcUrl: string;
  signer: SolanaSigner;
  commitment?: web3.Commitment;
}

type MatchStartHandler = (event: MatchStart) => void;

// Anchor's IDL type juggling — we treat the program as `any` because typing
// against a string-literal IDL union in v0 is more friction than payoff.
// `Program<any>` still resolves to a strict-but-empty `AccountNamespace<any>`
// where `.account.match` etc. are typed as missing, so use raw `any` instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProgram = any;

/** Derive the Game PDA for a given string game id. PDA lives under the
 *  game_registry program. */
function gameIdToPubkey(id: GameId): web3.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), Buffer.from(id)],
    GAME_REGISTRY_PROGRAM_ID,
  );
  return pda;
}

function deriveMatchPda(gameIdPk: web3.PublicKey, nonce: bigint): web3.PublicKey {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("match"), gameIdPk.toBuffer(), nonceBuf],
    MATCH_PROGRAM_ID,
  );
  return pda;
}

function deriveVaultPda(matchPda: web3.PublicKey): web3.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), matchPda.toBuffer()],
    MATCH_PROGRAM_ID,
  );
  return pda;
}

function deriveXpBalancePda(gamePda: web3.PublicKey, player: web3.PublicKey): web3.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("xp"), gamePda.toBuffer(), player.toBuffer()],
    XP_LEDGER_PROGRAM_ID,
  );
  return pda;
}

function deriveXpReceiptPda(matchPda: web3.PublicKey, player: web3.PublicKey): web3.PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("xp-receipt"), matchPda.toBuffer(), player.toBuffer()],
    XP_LEDGER_PROGRAM_ID,
  );
  return pda;
}

function fakeBorshHex(...parts: string[]): string {
  return "0x" + createHash("sha256").update("x1-solana-borsh:" + parts.join("|")).digest("hex");
}

function fakeSignature(...parts: string[]): string {
  const a = createHash("sha256").update("x1-solana-sig-a:" + parts.join("|")).digest("hex");
  const b = createHash("sha256").update("x1-solana-sig-b:" + parts.join("|")).digest("hex");
  return "0x" + a + b;
}

/** Convert an Anchor enum-object like `{ created: {} }` to our string phase. */
function decodeMatchPhase(raw: unknown): MatchPhase {
  const o = raw as Record<string, unknown>;
  if ("created" in o) return "Created";
  if ("funded" in o) return "Funded";
  if ("live" in o) return "Live";
  if ("settled" in o) return "Settled";
  if ("paid" in o) return "Paid";
  throw new Error(`unknown match phase: ${JSON.stringify(raw)}`);
}

function decodeModel(raw: unknown): "TRUSTED" | "COSIGNED" | "OPTIMISTIC" | "ZK" {
  const o = raw as Record<string, unknown>;
  if ("trusted" in o) return "TRUSTED";
  if ("cosigned" in o) return "COSIGNED";
  if ("optimistic" in o) return "OPTIMISTIC";
  if ("zk" in o) return "ZK";
  throw new Error(`unknown attestation model: ${JSON.stringify(raw)}`);
}

function decodeTier(raw: unknown): "DEMO" | "LIVE" | "FEATURED" {
  const o = raw as Record<string, unknown>;
  if ("demo" in o) return "DEMO";
  if ("live" in o) return "LIVE";
  if ("featured" in o) return "FEATURED";
  throw new Error(`unknown tier: ${JSON.stringify(raw)}`);
}

// Account shapes from the IDL — typed loosely; we cast at the boundary.
interface GameAccountRaw {
  devPubkey: web3.PublicKey;
  attestorPubkey: web3.PublicKey;
  revenueReceiver: web3.PublicKey;
  simulatorSha256: number[];
  tier: unknown;
  seatsMin: number;
  seatsMax: number;
  createdAt: anchor.BN;
  id: string;
  bump: number;
}

interface WinnerEntryRaw {
  pubkey: web3.PublicKey;
  payout: anchor.BN;
}

interface MatchOutcomeRaw {
  winners: WinnerEntryRaw[];
  rake: anchor.BN;
  replayHash: number[];
  postedAt: anchor.BN;
}

interface MatchAccountRaw {
  gameId: web3.PublicKey;
  nonce: anchor.BN;
  seats: number;
  stakePerSeat: anchor.BN;
  rakeBps: number;
  fundingDeadline: anchor.BN;
  settlementDeadline: anchor.BN;
  model: unknown;
  state: unknown;
  creator: web3.PublicKey;
  attestor: web3.PublicKey;
  treasury: web3.PublicKey;
  outcome: MatchOutcomeRaw | null;
  challengeWindowSecs: number;
  settledAt: anchor.BN;
  housePrize: anchor.BN;
  players: web3.PublicKey[];
  bump: number;
  vaultBump: number;
}

// ---------------------------------------------------------------------------

export class SolanaBackend {
  readonly actorPubkey: Pubkey;
  private readonly connection: web3.Connection;
  private readonly provider: anchor.AnchorProvider;
  private readonly program: AnyProgram;
  private readonly registry: AnyProgram;
  private readonly xp: AnyProgram;
  private readonly signerPubkey: web3.PublicKey;

  constructor(opts: SolanaBackendOptions) {
    this.connection = new Connection(opts.rpcUrl, opts.commitment ?? "confirmed");
    // Anchor's Wallet *interface* is duck-typed (publicKey + sign methods).
    // For a Keypair we wrap it in Anchor's Wallet class; a wallet-adapter is
    // already shaped correctly and goes straight through.
    const wallet = isKeypair(opts.signer) ? new Wallet(opts.signer) : opts.signer;
    this.signerPubkey = opts.signer.publicKey;
    this.provider = new AnchorProvider(this.connection, wallet, {
      commitment: opts.commitment ?? "confirmed",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.program = new Program(matchIdlJson as any, this.provider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.registry = new Program(gameRegistryIdlJson as any, this.provider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.xp = new Program(xpLedgerIdlJson as any, this.provider);
    this.actorPubkey = this.signerPubkey.toBase58();
  }

  // ---------------------------------------------------------------------------

  async listGames(): Promise<GameView[]> {
    const all = await this.registry.account.game.all();
    return all.map((a: { publicKey: web3.PublicKey; account: GameAccountRaw }) =>
      this.toGameView(a.publicKey, a.account),
    );
  }

  async getGame(id: GameId): Promise<GameView> {
    const gamePda = gameIdToPubkey(id);
    const g = (await this.registry.account.game.fetch(gamePda)) as GameAccountRaw;
    return this.toGameView(gamePda, g);
  }

  async listMatches(input: ListMatchesInput): Promise<MatchView[]> {
    const limit = input.limit ?? 100;
    // Game PDA is the first field after the 8-byte discriminator on Match.
    const filters: anchor.web3.GetProgramAccountsFilter[] = input.gameId
      ? [
          {
            memcmp: {
              offset: 8,
              bytes: gameIdToPubkey(input.gameId).toBase58(),
            },
          },
        ]
      : [];
    const all = await this.program.account.match.all(filters);
    const views: MatchView[] = [];
    for (const a of all.slice(0, limit)) {
      const matchPda = a.publicKey as web3.PublicKey;
      views.push(await this.matchAccountToView(matchPda.toBase58(), a.account as MatchAccountRaw));
    }
    return views;
  }

  async registerGame(reg: GameRegistration): Promise<{ gameId: GameId; attestorPubkey: Pubkey }> {
    const gamePda = gameIdToPubkey(reg.id);

    // Already registered? Treat as idempotent — return existing values.
    const existing = await this.connection.getAccountInfo(gamePda);
    if (existing) {
      const g = await this.registry.account.game.fetch(gamePda);
      return {
        gameId: reg.id,
        attestorPubkey: (g.attestorPubkey as web3.PublicKey).toBase58(),
      };
    }

    const simBytes = Buffer.from(reg.simulator.sha256.slice(2), "hex");
    if (simBytes.length !== 32) {
      throw new Error("BadRequest: simulator.sha256 must decode to 32 bytes");
    }

    await this.registry.methods
      .registerGame({
        id: reg.id,
        attestorPubkey: new PublicKey(reg.attestorPubkey),
        revenueReceiver: new PublicKey(reg.revenueReceiver),
        simulatorSha256: Array.from(simBytes),
        tier: encodeTier(reg.tier),
        seatsMin: reg.seats.min,
        seatsMax: reg.seats.max,
      })
      .accounts({
        game: gamePda,
        dev: this.signerPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { gameId: reg.id, attestorPubkey: reg.attestorPubkey };
  }

  subscribeMatchStart(_gameId: GameId, _handler: MatchStartHandler): () => void {
    // Solana backend v0 has no on-chain event push. Subscribe is a no-op so
    // callers can construct backend-agnostic clients without conditionals.
    // Use `platform.getMatch(matchId)` once you know a match has gone Live —
    // games that need pub-sub today should use network: "stub" for now.
    return () => {};
  }

  async createMatch(input: CreateMatchInput): Promise<{ matchId: MatchId; vaultAddress: Pubkey }> {
    if (!input.attestor) {
      throw new Error("BadRequest: `attestor` is required for the Solana backend");
    }
    if (!input.treasury) {
      throw new Error("BadRequest: `treasury` is required for the Solana backend");
    }

    const gameIdPk = gameIdToPubkey(input.gameId);
    // Sanity-check the game is registered.
    const gameInfo = await this.connection.getAccountInfo(gameIdPk);
    if (!gameInfo) {
      throw new Error(
        `NotFound: game "${input.gameId}" is not registered. ` +
          `Call platform.registerGame(...) first.`,
      );
    }
    // Random 8-byte nonce; matchId is deterministic from (gameId, nonce).
    const nonceBytes = crypto.getRandomValues(new Uint8Array(8));
    const nonce =
      (BigInt(nonceBytes[0]!) << 0n) |
      (BigInt(nonceBytes[1]!) << 8n) |
      (BigInt(nonceBytes[2]!) << 16n) |
      (BigInt(nonceBytes[3]!) << 24n) |
      (BigInt(nonceBytes[4]!) << 32n) |
      (BigInt(nonceBytes[5]!) << 40n) |
      (BigInt(nonceBytes[6]!) << 48n) |
      (BigInt(nonceBytes[7]!) << 56n);

    const matchPda = deriveMatchPda(gameIdPk, nonce);
    const vaultPda = deriveVaultPda(matchPda);
    const now = Math.floor(Date.now() / 1000);

    const challengeWindowSecs =
      input.challengeWindowSecs ?? (input.model === "OPTIMISTIC" ? 3600 : 0);
    const housePrize = input.housePrize ? new BN(input.housePrize) : new BN(0);

    await this.program.methods
      .createMatch({
        nonce: new BN(nonce.toString()),
        seats: input.seats,
        stakePerSeat: new BN(input.stakePerSeat),
        rakeBps: input.rakeBps,
        fundingDeadline: new BN(now + input.fundingDeadlineSec),
        settlementDeadline: new BN(now + input.settlementDeadlineSec),
        model: this.encodeModel(input.model),
        attestor: new PublicKey(input.attestor),
        treasury: new PublicKey(input.treasury),
        challengeWindowSecs,
        housePrize,
      })
      .accounts({
        game: gameIdPk,
        matchAccount: matchPda,
        vault: vaultPda,
        creator: this.signerPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return {
      matchId: matchPda.toBase58(),
      vaultAddress: vaultPda.toBase58(),
    };
  }

  async joinMatch(input: JoinMatchInput): Promise<{ state: MatchPhase }> {
    const matchPda = new PublicKey(input.matchId);
    const vaultPda = deriveVaultPda(matchPda);

    await this.program.methods
      .joinMatch()
      .accounts({
        matchAccount: matchPda,
        vault: vaultPda,
        player: this.signerPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const m = await this.program.account.match.fetch(matchPda);
    return { state: decodeMatchPhase(m.state) };
  }

  async signAndPostOutcome(input: SignAndPostInput): Promise<OutcomeEnvelope> {
    const matchPda = new PublicKey(input.matchId);
    const vaultPda = deriveVaultPda(matchPda);

    if (input.winners.length !== input.payoutShares.length || input.winners.length < 1) {
      throw new Error("BadRequest: winners and payoutShares must be same non-empty length");
    }

    const m = await this.program.account.match.fetch(matchPda);
    const treasuryPk: web3.PublicKey = m.treasury;

    const hashBytes = Buffer.from(input.replayHash.slice(2), "hex");
    if (hashBytes.length !== 32) {
      throw new Error(`BadRequest: replayHash must decode to 32 bytes`);
    }

    const payouts = input.payoutShares.map((p) => new BN(p));
    const remainingAccounts = input.winners.map((w) => ({
      pubkey: new PublicKey(w),
      isSigner: false,
      isWritable: true,
    }));

    await this.program.methods
      .postOutcome({
        payouts,
        replayHash: Array.from(hashBytes),
      })
      .accounts({
        matchAccount: matchPda,
        vault: vaultPda,
        attestor: this.signerPubkey,
        treasury: treasuryPk,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    // Build the off-chain envelope for the caller. The on-chain truth is the
    // settled Match account; the envelope is the artifact the caller archives.
    const body: OutcomeBody = OutcomeBody.parse({
      matchId: input.matchId,
      winners: input.winners,
      payoutShares: input.payoutShares,
      replayHash: input.replayHash,
      postedAt: Math.floor(Date.now() / 1000),
      attestor: this.actorPubkey,
    });

    return OutcomeEnvelope.parse({
      protocolVersion: "v0",
      outcome: body,
      borsh: fakeBorshHex(input.matchId, input.idempotencyKey),
      signature: fakeSignature(input.matchId, input.idempotencyKey),
      idempotencyKey: input.idempotencyKey,
    });
  }

  async getMatch(matchId: MatchId): Promise<MatchView> {
    const matchPda = new PublicKey(matchId);
    const m = (await this.program.account.match.fetch(matchPda)) as MatchAccountRaw;
    return this.matchAccountToView(matchId, m);
  }

  async finalizeMatch(input: FinalizeMatchInput): Promise<{ state: MatchPhase }> {
    const matchPda = new PublicKey(input.matchId);
    const m = (await this.program.account.match.fetch(matchPda)) as MatchAccountRaw;
    const outcome = m.outcome;
    if (!outcome) throw new Error("BadRequest: match has no outcome to finalize");

    const vaultPda = deriveVaultPda(matchPda);
    const remainingAccounts = outcome.winners.map((w) => ({
      pubkey: w.pubkey,
      isSigner: false,
      isWritable: true,
    }));

    await this.program.methods
      .finalizeMatch()
      .accounts({
        matchAccount: matchPda,
        vault: vaultPda,
        treasury: m.treasury,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    const updated = (await this.program.account.match.fetch(matchPda)) as MatchAccountRaw;
    return { state: decodeMatchPhase(updated.state) };
  }

  private async matchAccountToView(matchId: MatchId, m: MatchAccountRaw): Promise<MatchView> {
    const matchPda = new PublicKey(matchId);
    const phase = decodeMatchPhase(m.state);
    const players: Pubkey[] = m.players.map((p) => p.toBase58());
    const vaultPda = deriveVaultPda(matchPda);
    const vaultInfo = await this.connection.getAccountInfo(vaultPda);
    const vaultLamports = (vaultInfo?.lamports ?? 0).toString();
    const seed = "0x" + createHash("sha256").update(`seed:${matchId}`).digest("hex").slice(0, 16);

    let outcome: OutcomeBody | undefined;
    if (m.outcome) {
      const o = m.outcome;
      const replayHashHex = "0x" + Buffer.from(o.replayHash).toString("hex");
      outcome = OutcomeBody.parse({
        matchId,
        winners: o.winners.map((w) => w.pubkey.toBase58()),
        payoutShares: o.winners.map((w) => w.payout.toString()),
        replayHash: replayHashHex,
        postedAt: o.postedAt.toNumber(),
        attestor: m.attestor.toBase58(),
      });
    }

    return {
      matchId,
      gameId: m.gameId.toBase58(),
      state: phase,
      players,
      vaultLamports,
      seats: m.seats,
      stakePerSeat: m.stakePerSeat.toString(),
      housePrize: m.housePrize.toString(),
      rakeBps: m.rakeBps,
      model: decodeModel(m.model),
      attestorPubkey: m.attestor.toBase58(),
      seed,
      challengeWindowSecs: m.challengeWindowSecs,
      settledAt: m.settledAt.toNumber(),
      ...(outcome ? { outcome } : {}),
    };
  }

  private toGameView(pda: web3.PublicKey, g: GameAccountRaw): GameView {
    return {
      gameId: g.id,
      gamePda: pda.toBase58(),
      devPubkey: g.devPubkey.toBase58(),
      attestorPubkey: g.attestorPubkey.toBase58(),
      revenueReceiver: g.revenueReceiver.toBase58(),
      simulatorSha256: "0x" + Buffer.from(g.simulatorSha256).toString("hex"),
      tier: decodeTier(g.tier),
      seatsMin: g.seatsMin,
      seatsMax: g.seatsMax,
      createdAt: g.createdAt.toNumber(),
    };
  }

  // ---------------------------------------------------------------------------
  // XP ledger surface
  // ---------------------------------------------------------------------------

  async creditXp(input: CreditXpInput): Promise<{ amount: string; balance: string }> {
    const matchPda = new PublicKey(input.matchId);
    const playerPk = new PublicKey(input.player);

    const m = await this.program.account.match.fetch(matchPda);
    const gamePda = m.gameId as web3.PublicKey;

    const xpBalance = deriveXpBalancePda(gamePda, playerPk);
    const receipt = deriveXpReceiptPda(matchPda, playerPk);

    await this.xp.methods
      .creditXp()
      .accounts({
        matchAccount: matchPda,
        player: playerPk,
        xpBalance,
        creditReceipt: receipt,
        payer: this.signerPubkey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const b = await this.xp.account.xpBalance.fetch(xpBalance);
    const r = await this.xp.account.creditReceipt.fetch(receipt);
    return {
      amount: (r.amount as anchor.BN).toString(),
      balance: (b.amount as anchor.BN).toString(),
    };
  }

  async getXp(input: GetXpInput): Promise<XpView> {
    const gamePda = gameIdToPubkey(input.gameId);
    const playerPk = new PublicKey(input.player);
    const xpBalance = deriveXpBalancePda(gamePda, playerPk);
    const info = await this.connection.getAccountInfo(xpBalance);
    if (!info) {
      return { game: gamePda.toBase58(), player: input.player, amount: "0" };
    }
    const b = await this.xp.account.xpBalance.fetch(xpBalance);
    return {
      game: (b.game as web3.PublicKey).toBase58(),
      player: (b.player as web3.PublicKey).toBase58(),
      amount: (b.amount as anchor.BN).toString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Replay storage
  //
  // v0 stores replays in the process-wide in-memory store. The on-chain
  // commitment is only the SHA-256 of the canonical-JSON body; the body itself
  // is platform-side state. When the platform exposes a real HTTPS replay
  // service, this backend will switch to that — same SDK surface, no caller
  // changes.
  // ---------------------------------------------------------------------------

  async uploadReplay(input: UploadReplayInput): Promise<UploadReplayResult> {
    const stored = getDefaultReplayStore().put(input.replay);
    return {
      matchId: stored.matchId,
      replayHash: stored.hash,
      bytes: Buffer.byteLength(stored.body, "utf8"),
    };
  }

  async getReplay(input: GetReplayInput): Promise<ReplayView> {
    const stored = getDefaultReplayStore().get(input.matchId);
    if (!stored) throw new Error(`NotFound: replay for match "${input.matchId}"`);
    return {
      matchId: stored.matchId,
      replayHash: stored.hash,
      replay: stored.parsed,
      bytes: Buffer.byteLength(stored.body, "utf8"),
    };
  }

  // ---------------------------------------------------------------------------

  private encodeModel(model: CreateMatchInput["model"]): Record<string, Record<string, never>> {
    switch (model) {
      case "TRUSTED":
        return { trusted: {} };
      case "COSIGNED":
        return { cosigned: {} };
      case "OPTIMISTIC":
        return { optimistic: {} };
      case "ZK":
        return { zk: {} };
    }
  }
}

function encodeTier(tier: GameRegistration["tier"]): Record<string, Record<string, never>> {
  switch (tier) {
    case "DEMO":
      return { demo: {} };
    case "LIVE":
      return { live: {} };
    case "FEATURED":
      return { featured: {} };
  }
}
