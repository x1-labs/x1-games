// In-memory stub backend implementing the @x1-labs/games-protocol contract.
//
// State, signatures, pubkeys, and lamports here are FAKE but VALID per the
// contract schemas. A game integrated against this stub will pass schema
// validation when pointed at devnet. Switch from stub → devnet by changing
// `network` only.

import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import * as web3 from "@solana/web3.js";
import {
  GameRegistration,
  MatchStart,
  OutcomeBody,
  OutcomeEnvelope,
  getDefaultReplayStore,
  type GameId,
  type MatchId,
  type Pubkey,
  type AttestationModel,
  type XntLamports,
  type Hash,
  type Replay,
} from "@x1-labs/games-protocol";
import { buildEnvelopeAttestation, BN } from "./attestation.js";

// Base58 alphabet (matches the regex in games-protocol).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Encode 32 bytes as a base58 string. Bitcoin-style alphabet. */
function base58FromBytes(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    out = B58[r]! + out;
    n = n / 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

function fakePubkey(tag: string): Pubkey {
  const digest = createHash("sha256").update(`x1-stub:${tag}`).digest();
  return base58FromBytes(digest);
}

// =============================================================================
// Stored state shapes
// =============================================================================

/** Per-game stored data, including a real ed25519 keypair the stub uses as the
 *  attestor. Even for SELF_HOSTED games the stub holds its own keypair — the
 *  alternative would be to ship un-signable envelopes from stub-mode, which
 *  is exactly the dishonest behavior this whole refactor exists to remove.
 *  Stub mode is dev-only; the published attestor pubkey from registerGame is
 *  the stub's own, NOT whatever the dev passed in `reg.attestorPubkey`. */
type StoredGame = GameRegistration & {
  gameId: GameId;
  /** Stub-generated ed25519 keypair. publicKey/secretKey are raw bytes from
   *  tweetnacl; we re-encode the pubkey to base58 when surfacing it. */
  attestorKeypair: nacl.SignKeyPair;
};

export type MatchPhase = "Created" | "Funded" | "Live" | "Settled" | "Paid";

interface StoredMatch {
  matchId: MatchId;
  gameId: GameId;
  seats: number;
  stakePerSeat: XntLamports;
  housePrize: XntLamports;
  rakeBps: number;
  model: AttestationModel;
  attestorPubkey: Pubkey;
  players: Pubkey[];
  state: MatchPhase;
  vaultLamports: bigint;
  fundingDeadline: number;
  settlementDeadline: number;
  challengeWindowSecs: number;
  settledAt: number; // unix sec, 0 until Settled
  outcome?: OutcomeBody;
}

type MatchStartHandler = (event: MatchStart) => void;

// =============================================================================
// Public input shapes
// =============================================================================

export interface CreateMatchInput {
  gameId: GameId;
  seats: number;
  stakePerSeat: XntLamports;
  housePrize: XntLamports | null;
  rakeBps: number;
  model: AttestationModel;
  fundingDeadlineSec: number;
  settlementDeadlineSec: number;
  /** Attestor pubkey. For MANAGED stub games this is the platform-allocated key. */
  attestor?: Pubkey;
  /** Treasury pubkey. Optional in stub (rake isn't accounted). */
  treasury?: Pubkey;
  /** Dispute window between settle and finalize. Defaults: 0 for TRUSTED/COSIGNED, 3600 for OPTIMISTIC. */
  challengeWindowSecs?: number;
}

export interface FinalizeMatchInput {
  matchId: MatchId;
}

export interface UploadReplayInput {
  replay: Replay;
}

export interface UploadReplayResult {
  matchId: MatchId;
  /** Hash to commit on-chain as OutcomeBody.replayHash. */
  replayHash: Hash;
  /** Canonical-JSON byte length. */
  bytes: number;
}

export interface GetReplayInput {
  matchId: MatchId;
}

export interface ReplayView {
  matchId: MatchId;
  replayHash: Hash;
  replay: Replay;
  bytes: number;
}

export interface JoinMatchInput {
  matchId: MatchId;
}

export interface SignAndPostInput {
  matchId: MatchId;
  gameId: GameId;
  winners: Pubkey[];
  payoutShares: XntLamports[];
  replayHash: Hash;
  idempotencyKey: string;
}

export interface MatchView {
  matchId: MatchId;
  gameId: GameId;
  state: MatchPhase;
  players: Pubkey[];
  vaultLamports: XntLamports;
  /** Configured at match creation; sufficient to compute pot, rake, payouts. */
  seats: number;
  stakePerSeat: XntLamports;
  rakeBps: number;
  model: AttestationModel;
  attestorPubkey: Pubkey;
  /** Deterministic, derived from matchId. Used for in-game RNG. */
  seed: string;
  /** Dispute window in seconds (0 for TRUSTED/COSIGNED). */
  challengeWindowSecs: number;
  /** Unix sec the outcome was posted. 0 until Settled. */
  settledAt: number;
  /** House contribution to the pot, in lamports. "0" for pure-PvP. */
  housePrize: XntLamports;
  outcome?: OutcomeBody;
}

export interface CreditXpInput {
  matchId: MatchId;
  player: Pubkey;
}

export interface XpView {
  game: Pubkey;   // on-chain Game PDA; stub returns gameId echo
  player: Pubkey;
  amount: string; // XP balance, decimal-encoded
}

export interface GetXpInput {
  gameId: GameId;
  player: Pubkey;
}

export interface GameView {
  gameId: GameId;
  gamePda: Pubkey;
  devPubkey: Pubkey;
  attestorPubkey: Pubkey;
  revenueReceiver: Pubkey;
  simulatorSha256: string;       // 0x + 64 hex
  tier: "DEMO" | "LIVE" | "FEATURED";
  seatsMin: number;
  seatsMax: number;
  createdAt: number;             // unix sec
}

export interface ListMatchesInput {
  gameId?: GameId | undefined;
  /** Limit returned set; default 100. */
  limit?: number | undefined;
}

// =============================================================================
// Process-wide shared state
//
// Stub state is a singleton so multiple Platform instances within one process
// (multiple actors in a test) share game registrations and match state. This
// mirrors the on-chain reality: all actors see the same chain.
// =============================================================================

class StubState {
  games = new Map<GameId, StoredGame>();
  matches = new Map<MatchId, StoredMatch>();
  subs = new Map<GameId, Set<MatchStartHandler>>();
  outcomes = new Map<string, OutcomeEnvelope>();
  xpBalances = new Map<string, bigint>();  // key: `${gameId}:${player}`
  xpReceipts = new Set<string>();          // key: `${matchId}:${player}`
  matchNonce = 0;

  reset() {
    this.games.clear();
    this.matches.clear();
    this.subs.clear();
    this.outcomes.clear();
    this.xpBalances.clear();
    this.xpReceipts.clear();
    this.matchNonce = 0;
  }
}

const STATE = new StubState();

/** Reset the process-wide stub state. Tests call this in beforeEach.
 *  Also clears the shared replay store so tests that re-use matchIds don't
 *  collide. */
export function __resetStub(): void {
  STATE.reset();
  getDefaultReplayStore().reset();
}

// =============================================================================
// StubBackend
//
// One instance per Platform. All instances share STATE so multi-actor tests
// see consistent state without an explicit shared-backend ceremony.
// =============================================================================

export class StubBackend {
  /** The "actor" this backend instance represents — used as the signer pubkey. */
  readonly actorPubkey: Pubkey;

  constructor(opts: { actorPubkey: Pubkey }) {
    this.actorPubkey = opts.actorPubkey;
  }

  async registerGame(reg: GameRegistration): Promise<{ gameId: GameId; attestorPubkey: Pubkey }> {
    GameRegistration.parse(reg);
    // Generate a real ed25519 keypair so stub-issued OutcomeEnvelopes carry a
    // verifiable signature. We override reg.attestorPubkey unconditionally —
    // stub mode is dev-only and can't sign for arbitrary external pubkeys.
    const kp = nacl.sign.keyPair();
    const attestorPubkey = bs58.encode(kp.publicKey);
    STATE.games.set(reg.id, {
      ...reg,
      gameId: reg.id,
      attestorPubkey,
      attestorKeypair: kp,
    });
    return { gameId: reg.id, attestorPubkey };
  }

  async listGames(): Promise<GameView[]> {
    return Array.from(STATE.games.values()).map((g) => this.toGameView(g));
  }

  async getGame(id: GameId): Promise<GameView> {
    const g = STATE.games.get(id);
    if (!g) throw new Error(`NotFound: game "${id}"`);
    return this.toGameView(g);
  }

  async listMatches(input: ListMatchesInput): Promise<MatchView[]> {
    const limit = input.limit ?? 100;
    const all = Array.from(STATE.matches.values());
    const filtered = input.gameId ? all.filter((m) => m.gameId === input.gameId) : all;
    return filtered.slice(0, limit).map((m) => this.viewFrom(m));
  }

  private toGameView(g: StoredGame): GameView {
    return {
      gameId: g.gameId,
      gamePda: fakePubkey(`game-pda:${g.gameId}`),
      devPubkey: g.devPubkey,
      attestorPubkey: g.attestorPubkey,
      revenueReceiver: g.revenueReceiver,
      simulatorSha256: g.simulator.sha256,
      tier: g.tier,
      seatsMin: g.seats.min,
      seatsMax: g.seats.max,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  private viewFrom(m: StoredMatch): MatchView {
    const seed = "0x" + createHash("sha256").update(`seed:${m.matchId}`).digest("hex").slice(0, 16);
    return {
      matchId: m.matchId,
      gameId: m.gameId,
      state: m.state,
      players: [...m.players],
      vaultLamports: m.vaultLamports.toString(),
      seats: m.seats,
      stakePerSeat: m.stakePerSeat,
      rakeBps: m.rakeBps,
      model: m.model,
      attestorPubkey: m.attestorPubkey,
      seed,
      challengeWindowSecs: m.challengeWindowSecs,
      settledAt: m.settledAt,
      housePrize: m.housePrize ?? "0",
      ...(m.outcome ? { outcome: m.outcome } : {}),
    };
  }

  subscribeMatchStart(gameId: GameId, handler: MatchStartHandler): () => void {
    let set = STATE.subs.get(gameId);
    if (!set) {
      set = new Set();
      STATE.subs.set(gameId, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  async createMatch(input: CreateMatchInput): Promise<{ matchId: MatchId; vaultAddress: Pubkey }> {
    const game = STATE.games.get(input.gameId);
    if (!game) {
      throw new Error(`NotFound: game "${input.gameId}" is not registered`);
    }

    STATE.matchNonce += 1;
    const matchId = fakePubkey(`match:${input.gameId}:${STATE.matchNonce}`);
    const vaultAddress = fakePubkey(`vault:${matchId}`);
    const now = Math.floor(Date.now() / 1000);
    const houseLamports = input.housePrize ? BigInt(input.housePrize) : 0n;
    const challengeWindowSecs =
      input.challengeWindowSecs ?? (input.model === "OPTIMISTIC" ? 3600 : 0);

    STATE.matches.set(matchId, {
      matchId,
      gameId: input.gameId,
      seats: input.seats,
      stakePerSeat: input.stakePerSeat,
      rakeBps: input.rakeBps,
      model: input.model,
      attestorPubkey: game.attestorPubkey,
      players: [],
      state: "Created",
      vaultLamports: houseLamports,
      fundingDeadline: now + input.fundingDeadlineSec,
      settlementDeadline: now + input.settlementDeadlineSec,
      challengeWindowSecs,
      settledAt: 0,
      housePrize: input.housePrize ?? "0",
    });

    return { matchId, vaultAddress };
  }

  async joinMatch(input: JoinMatchInput): Promise<{ state: MatchPhase }> {
    const m = STATE.matches.get(input.matchId);
    if (!m) throw new Error(`NotFound: match "${input.matchId}"`);
    if (m.state !== "Created" && m.state !== "Funded") {
      throw new Error(`MatchNotInState: cannot join in state "${m.state}"`);
    }
    if (m.players.length >= m.seats) {
      throw new Error(`Conflict: match is full`);
    }
    if (m.players.includes(this.actorPubkey)) {
      throw new Error(`Conflict: player has already joined`);
    }

    m.players.push(this.actorPubkey);
    m.vaultLamports += BigInt(m.stakePerSeat);
    m.state = m.players.length === m.seats ? "Live" : "Funded";

    if (m.state === "Live") this.emitMatchStart(m);

    return { state: m.state };
  }

  async signAndPostOutcome(input: SignAndPostInput): Promise<OutcomeEnvelope> {
    const prior = STATE.outcomes.get(input.idempotencyKey);
    if (prior) return prior;

    const m = STATE.matches.get(input.matchId);
    if (!m) throw new Error(`NotFound: match "${input.matchId}"`);
    if (m.gameId !== input.gameId) {
      throw new Error(`BadRequest: gameId mismatch for match`);
    }
    if (m.state !== "Live") {
      throw new Error(`MatchNotInState: cannot settle in state "${m.state}"`);
    }
    if (input.winners.length !== input.payoutShares.length) {
      throw new Error(`BadRequest: winners.length must equal payoutShares.length`);
    }

    const body: OutcomeBody = OutcomeBody.parse({
      matchId: input.matchId,
      winners: input.winners,
      payoutShares: input.payoutShares,
      replayHash: input.replayHash,
      postedAt: Math.floor(Date.now() / 1000),
      attestor: m.attestorPubkey,
    });

    // Sign the canonical attestation payload with the per-game stub keypair.
    // The resulting envelope is verifiable by verifyOutcomeEnvelope() — same
    // path as a real chain-issued envelope.
    const game = STATE.games.get(m.gameId);
    if (!game) throw new Error(`Internal: game "${m.gameId}" missing for match "${input.matchId}"`);
    const hashBytes = Buffer.from(input.replayHash.slice(2), "hex");
    const { borsh, signature } = await buildEnvelopeAttestation({
      matchPda: new web3.PublicKey(input.matchId),
      args: {
        payouts: input.payoutShares.map((p) => new BN(p)),
        replayHash: Array.from(hashBytes),
      },
      sign: async (payload) => nacl.sign.detached(payload, game.attestorKeypair.secretKey),
    });

    const envelope: OutcomeEnvelope = OutcomeEnvelope.parse({
      protocolVersion: "v0",
      outcome: body,
      borsh,
      signature,
      idempotencyKey: input.idempotencyKey,
    });

    m.outcome = body;
    m.settledAt = Math.floor(Date.now() / 1000);
    // For zero-window models we settle and finalize atomically in the stub —
    // mirrors the on-chain TRUSTED behavior.
    m.state = m.challengeWindowSecs === 0 ? "Paid" : "Settled";
    STATE.outcomes.set(input.idempotencyKey, envelope);
    return envelope;
  }

  async finalizeMatch(input: FinalizeMatchInput): Promise<{ state: MatchPhase }> {
    const m = STATE.matches.get(input.matchId);
    if (!m) throw new Error(`NotFound: match "${input.matchId}"`);
    if (m.state !== "Settled") {
      throw new Error(`MatchNotInState: cannot finalize in state "${m.state}"`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (now < m.settledAt + m.challengeWindowSecs) {
      throw new Error(`ChallengeWindowOpen: not yet finalizable`);
    }
    m.state = "Paid";
    return { state: m.state };
  }

  async getMatch(matchId: MatchId): Promise<MatchView> {
    const m = STATE.matches.get(matchId);
    if (!m) throw new Error(`NotFound: match "${matchId}"`);
    const seed = "0x" + createHash("sha256").update(`seed:${m.matchId}`).digest("hex").slice(0, 16);
    return {
      matchId: m.matchId,
      gameId: m.gameId,
      state: m.state,
      players: [...m.players],
      vaultLamports: m.vaultLamports.toString(),
      seats: m.seats,
      stakePerSeat: m.stakePerSeat,
      rakeBps: m.rakeBps,
      model: m.model,
      attestorPubkey: m.attestorPubkey,
      seed,
      challengeWindowSecs: m.challengeWindowSecs,
      settledAt: m.settledAt,
      housePrize: m.housePrize ?? "0",
      ...(m.outcome ? { outcome: m.outcome } : {}),
    };
  }

  // --- XP ledger surface ---------------------------------------------------

  async creditXp(input: CreditXpInput): Promise<{ amount: string; balance: string }> {
    const m = STATE.matches.get(input.matchId);
    if (!m) throw new Error(`NotFound: match "${input.matchId}"`);
    if (m.state !== "Settled" && m.state !== "Paid") {
      throw new Error(`MatchNotInState: cannot credit XP, state is "${m.state}"`);
    }
    if (!m.players.includes(input.player)) {
      throw new Error(`BadRequest: ${input.player} is not a participant`);
    }

    const receiptKey = `${input.matchId}:${input.player}`;
    if (STATE.xpReceipts.has(receiptKey)) {
      throw new Error(`Conflict: XP already credited for this (match, player)`);
    }

    const isWinner = m.outcome?.winners.includes(input.player) ?? false;
    const amount = isWinner ? 100n : 25n;

    const balanceKey = `${m.gameId}:${input.player}`;
    const prior = STATE.xpBalances.get(balanceKey) ?? 0n;
    const next = prior + amount;
    STATE.xpBalances.set(balanceKey, next);
    STATE.xpReceipts.add(receiptKey);

    return { amount: amount.toString(), balance: next.toString() };
  }

  async getXp(input: GetXpInput): Promise<XpView> {
    const balanceKey = `${input.gameId}:${input.player}`;
    const amount = STATE.xpBalances.get(balanceKey) ?? 0n;
    return {
      game: input.gameId, // stub: echo the human gameId
      player: input.player,
      amount: amount.toString(),
    };
  }

  // --- Replay storage ---------------------------------------------------

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

  private emitMatchStart(m: StoredMatch): void {
    const handlers = STATE.subs.get(m.gameId);
    if (!handlers || handlers.size === 0) return;

    const event: MatchStart = MatchStart.parse({
      protocolVersion: "v0",
      matchId: m.matchId,
      gameId: m.gameId,
      seed: "0x" + createHash("sha256").update(`seed:${m.matchId}`).digest("hex").slice(0, 16),
      seats: m.seats,
      stakePerSeat: m.stakePerSeat,
      housePrize: m.housePrize,
      rakeBps: m.rakeBps,
      model: m.model,
      players: [...m.players],
      attestorPubkey: m.attestorPubkey,
      fundingDeadline: m.fundingDeadline,
      settlementDeadline: m.settlementDeadline,
      outcomeEndpoint: `https://stub.local/v0/games/${m.gameId}/matches/${m.matchId}/outcome`,
      replayUploadUrl:
        m.model === "OPTIMISTIC" ? `https://stub.local/replays/${m.matchId}` : null,
    });

    for (const h of handlers) h(event);
  }
}
