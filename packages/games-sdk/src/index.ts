// @x1-labs/games-sdk
//
// One Platform = one actor. The Platform holds a signer (real Keypair for
// chain backends, used as a stable pubkey for the stub) and routes calls to
// the backend selected by `network`.

import * as web3 from "@solana/web3.js";
import type {
  GameRegistration,
  MatchStart,
  OutcomeEnvelope,
  GameId,
  MatchId,
  Pubkey,
} from "@x1-labs/games-protocol";
import {
  StubBackend,
  type CreateMatchInput,
  type JoinMatchInput,
  type SignAndPostInput,
  type MatchView,
  type MatchPhase,
  type CreditXpInput,
  type GetXpInput,
  type XpView,
  type GameView,
  type ListMatchesInput,
  type FinalizeMatchInput,
  type UploadReplayInput,
  type UploadReplayResult,
  type GetReplayInput,
  type ReplayView,
} from "./stub.js";
import { SolanaBackend, type SolanaSigner, type WalletLikeSigner } from "./solana.js";

export { __resetStub } from "./stub.js";

const { Keypair } = web3;

export type Network = "x1-mainnet" | "x1-testnet" | "x1-localnet" | "stub";

const VALID_NETWORKS: readonly Network[] = [
  "x1-mainnet",
  "x1-testnet",
  "x1-localnet",
  "stub",
];

const DEFAULT_RPC_URLS: Record<Exclude<Network, "stub">, string> = {
  "x1-localnet": "http://127.0.0.1:8899",
  "x1-testnet": "https://rpc.testnet.x1.xyz",
  "x1-mainnet": "https://rpc.mainnet.x1.xyz",
};

export interface ConnectOptions {
  network: Network;
  /** Signer for this actor. Accepts either a raw `Keypair` (server-side, tests)
   *  or a `WalletLikeSigner` (browser wallets — Phantom, Solflare, Backpack, or
   *  anything from `@solana/wallet-adapter`). Defaults to a fresh Keypair for
   *  stub; required for chain backends. */
  signer?: SolanaSigner;
  /** Override RPC URL. Defaults per network. */
  rpcUrl?: string;
}

type MatchStartHandler = (event: MatchStart) => void;

interface Backend {
  readonly actorPubkey: Pubkey;
  registerGame(reg: GameRegistration): Promise<{ gameId: GameId; attestorPubkey: Pubkey }>;
  listGames(): Promise<GameView[]>;
  getGame(id: GameId): Promise<GameView>;
  subscribeMatchStart(gameId: GameId, handler: MatchStartHandler): () => void;
  createMatch(input: CreateMatchInput): Promise<{ matchId: MatchId; vaultAddress: Pubkey }>;
  joinMatch(input: JoinMatchInput): Promise<{ state: MatchPhase }>;
  signAndPostOutcome(input: SignAndPostInput): Promise<OutcomeEnvelope>;
  finalizeMatch(input: FinalizeMatchInput): Promise<{ state: MatchPhase }>;
  getMatch(matchId: MatchId): Promise<MatchView>;
  listMatches(input: ListMatchesInput): Promise<MatchView[]>;
  creditXp(input: CreditXpInput): Promise<{ amount: string; balance: string }>;
  getXp(input: GetXpInput): Promise<XpView>;
  uploadReplay(input: UploadReplayInput): Promise<UploadReplayResult>;
  getReplay(input: GetReplayInput): Promise<ReplayView>;
}

/** The platform client — one instance per actor. */
export class Platform {
  readonly network: Network;
  readonly signer: SolanaSigner;
  private readonly backend: Backend;

  private constructor(network: Network, signer: SolanaSigner, backend: Backend) {
    this.network = network;
    this.signer = signer;
    this.backend = backend;
  }

  /** The pubkey this Platform instance acts as. */
  get pubkey(): Pubkey {
    return this.backend.actorPubkey;
  }

  static connect(opts: ConnectOptions): Platform {
    if (!VALID_NETWORKS.includes(opts.network)) {
      throw new Error(
        `Unknown network: ${String(opts.network)}. ` +
          `Expected one of: ${VALID_NETWORKS.join(", ")}.`,
      );
    }

    const signer: SolanaSigner = opts.signer ?? Keypair.generate();

    if (opts.network === "stub") {
      return new Platform(
        "stub",
        signer,
        new StubBackend({ actorPubkey: signer.publicKey.toBase58() }),
      );
    }

    // All X1 chain networks share the same SolanaBackend; only the default
    // RPC URL differs. Callers can override with opts.rpcUrl (handy for
    // private RPCs or self-hosted validators).
    const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URLS[opts.network];
    return new Platform(
      opts.network,
      signer,
      new SolanaBackend({ rpcUrl, signer }),
    );
  }

  // ---------------------------------------------------------------------------
  // Game lifecycle
  // ---------------------------------------------------------------------------

  async registerGame(reg: GameRegistration): Promise<{ gameId: GameId; attestorPubkey: Pubkey }> {
    return this.backend.registerGame(reg);
  }

  async listGames(): Promise<GameView[]> {
    return this.backend.listGames();
  }

  async getGame(id: GameId): Promise<GameView> {
    return this.backend.getGame(id);
  }

  async listMatches(input: ListMatchesInput = {}): Promise<MatchView[]> {
    return this.backend.listMatches(input);
  }

  subscribeMatchStart(gameId: GameId, handler: MatchStartHandler): () => void {
    return this.backend.subscribeMatchStart(gameId, handler);
  }

  // ---------------------------------------------------------------------------
  // Match lifecycle
  // ---------------------------------------------------------------------------

  async createMatch(input: CreateMatchInput): Promise<{ matchId: MatchId; vaultAddress: Pubkey }> {
    return this.backend.createMatch(input);
  }

  async joinMatch(input: JoinMatchInput): Promise<{ state: MatchPhase }> {
    // The seated player is always the Platform's actor — the chain enforces
    // `player: Signer<'info>` on join_match, so you can only seat yourself.
    // Reject `{ player }` (or any other unknown field) to catch a common
    // mistake where callers think they can seat someone on the actor's behalf.
    const extras = Object.keys(input).filter((k) => k !== "matchId");
    if (extras.length > 0) {
      throw new Error(
        `BadRequest: joinMatch input has unsupported field(s): ${extras.join(", ")}. ` +
          `The seated player is always platform.actorPubkey — to seat a different ` +
          `key, construct a Platform with that key as the signer.`,
      );
    }
    return this.backend.joinMatch(input);
  }

  async signAndPostOutcome(input: SignAndPostInput): Promise<OutcomeEnvelope> {
    return this.backend.signAndPostOutcome(input);
  }

  async finalizeMatch(input: FinalizeMatchInput): Promise<{ state: MatchPhase }> {
    return this.backend.finalizeMatch(input);
  }

  async getMatch(matchId: MatchId): Promise<MatchView> {
    return this.backend.getMatch(matchId);
  }

  // ---------------------------------------------------------------------------
  // XP
  // ---------------------------------------------------------------------------

  async creditXp(input: CreditXpInput): Promise<{ amount: string; balance: string }> {
    return this.backend.creditXp(input);
  }

  async getXp(input: GetXpInput): Promise<XpView> {
    return this.backend.getXp(input);
  }

  // ---------------------------------------------------------------------------
  // Replays
  // ---------------------------------------------------------------------------

  async uploadReplay(input: UploadReplayInput): Promise<UploadReplayResult> {
    return this.backend.uploadReplay(input);
  }

  async getReplay(input: GetReplayInput): Promise<ReplayView> {
    return this.backend.getReplay(input);
  }
}

// Re-exports for consumer convenience.
export type {
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
} from "./stub.js";
export type { SolanaSigner, WalletLikeSigner } from "./solana.js";
export type {
  GameRegistration,
  MatchStart,
  OutcomeEnvelope,
  OutcomeBody,
  Replay,
  ErrorEnvelope,
  GameId,
  MatchId,
  Pubkey,
  Signature,
  Hash,
  AttestationModel,
  Tier,
  Runtime,
  XntLamports,
} from "@x1-labs/games-protocol";
