// TttGameServer — the glue between the pure session (src/session.ts) and the
// X1 Games platform SDK. Subscribes to MatchStart events, holds sessions,
// drives settlement on terminal state.

import type { Platform, MatchStart, Replay } from "@x1-labs/games-sdk";
import { TttSession } from "./session.ts";

const GAME_ID = "tic-tac-toe";
const SIMULATOR_SHA = "0x" + "00".repeat(32);

interface ServerOptions {
  readonly platform: Platform;
}

interface MoveInput {
  readonly matchId: string;
  readonly player: string;
  readonly cell: number;
}

interface PendingMatch {
  readonly start: MatchStart;
  readonly session: TttSession;
  settled: boolean;
}

// Canonical JSON + replay hashing now live in @x1-labs/games-protocol.
// We compose a Replay payload and hand it to the SDK's uploadReplay; the SDK
// canonicalizes + hashes + stores. The returned `replayHash` is what we
// commit on-chain via signAndPostOutcome.

export class TttGameServer {
  private readonly platform: Platform;
  private readonly matches = new Map<string, PendingMatch>();
  private readonly unsubscribe: () => void;

  constructor(opts: ServerOptions) {
    this.platform = opts.platform;
    this.unsubscribe = this.platform.subscribeMatchStart(GAME_ID, (start) => {
      this.onMatchStart(start);
    });
  }

  /** Drop the subscription. Useful for tests / teardown. */
  close(): void {
    this.unsubscribe();
  }

  /** Snapshot of a match's session, shaped for network broadcast. Null if
   *  the server isn't tracking the match (e.g. before attach). */
  snapshot(matchId: string): null | {
    matchId: string;
    board: ReadonlyArray<string | null>;
    turn: "X" | "O";
    status: "in_progress" | "won" | "draw";
    winner: string | null; // pubkey of winner, or null
    playerX: string;
    playerO: string;
    seats: number;
    settlementDeadline: number;
    settled: boolean;
  } {
    const m = this.matches.get(matchId);
    if (!m) return null;
    const s = m.session.state;
    return {
      matchId,
      board: s.board,
      turn: s.turn,
      status: s.status,
      winner: m.session.winnerPubkey(),
      playerX: m.session.players[0],
      playerO: m.session.players[1],
      seats: m.start.seats,
      settlementDeadline: m.start.settlementDeadline,
      settled: m.settled,
    };
  }

  /** Is this pubkey one of the two participants of this match? */
  isParticipant(matchId: string, player: string): boolean {
    const m = this.matches.get(matchId);
    if (!m) return false;
    return m.session.players.includes(player);
  }

  /** Manually settle a match — exposed for retry / idempotency testing. */
  async settleNow(matchId: string): Promise<void> {
    const m = this.matches.get(matchId);
    if (!m) throw new Error(`no session for match ${matchId}`);
    if (m.session.isTerminal() && !m.settled) await this.settle(matchId);
  }

  /** Explicitly attach a match by id. Used when the backend does not push
   *  MatchStart events (Solana backend v0). Fetches the live state and
   *  creates a session. Idempotent. */
  async attachMatch(matchId: string): Promise<void> {
    if (this.matches.has(matchId)) return;
    const view = await this.platform.getMatch(matchId);
    if (view.state !== "Live") {
      throw new Error(
        `match ${matchId} is not Live (state=${view.state}); cannot attach`,
      );
    }
    if (view.players.length !== 2) {
      throw new Error(`match ${matchId} has ${view.players.length} players, expected 2`);
    }
    const synthetic: MatchStart = {
      protocolVersion: "v0",
      matchId,
      gameId: GAME_ID,
      seed: view.seed,
      seats: view.seats,
      stakePerSeat: view.stakePerSeat,
      housePrize: null,
      rakeBps: view.rakeBps,
      model: view.model,
      players: view.players,
      attestorPubkey: view.attestorPubkey,
      fundingDeadline: 0,
      settlementDeadline: view.settlementDeadline,
      outcomeEndpoint: `local://attached/${matchId}/outcome`,
      replayUploadUrl: null,
    };
    this.onMatchStart(synthetic);
  }

  submitMove(input: MoveInput): Promise<void> | void {
    const m = this.matches.get(input.matchId);
    if (!m) throw new Error(`no session for match ${input.matchId}`);
    if (m.settled) throw new Error(`match ${input.matchId} already settled`);

    m.session.submitMove({ player: input.player, cell: input.cell });

    if (m.session.isTerminal() && !m.settled) {
      return this.settle(input.matchId);
    }
    return;
  }

  // ---------------------------------------------------------------------------

  private onMatchStart(start: MatchStart): void {
    if (this.matches.has(start.matchId)) return; // already tracking
    if (start.players.length !== 2) {
      // TTT requires exactly 2 seats; ignore malformed match-start.
      return;
    }
    const session = new TttSession({
      matchId: start.matchId,
      players: [start.players[0]!, start.players[1]!],
      seed: start.seed,
    });
    this.matches.set(start.matchId, { start, session, settled: false });
  }

  private async settle(matchId: string): Promise<void> {
    const m = this.matches.get(matchId);
    if (!m || m.settled) return;
    m.settled = true;

    const pot = BigInt(m.start.stakePerSeat) * BigInt(m.start.seats);
    const rake = (pot * BigInt(m.start.rakeBps)) / 10_000n;
    const distributable = pot - rake;

    let winners: string[];
    let payoutShares: string[];

    const winnerPubkey = m.session.winnerPubkey();
    if (winnerPubkey) {
      winners = [winnerPubkey];
      payoutShares = [distributable.toString()];
    } else {
      // Draw: split evenly. Two seats → halves; rounding remainder to player[0].
      const half = distributable / 2n;
      const remainder = distributable - half * 2n;
      winners = [m.start.players[0]!, m.start.players[1]!];
      payoutShares = [(half + remainder).toString(), half.toString()];
    }

    // Build the canonical Replay payload (INTEGRATION.md §3.4) and upload it
    // BEFORE posting the outcome. The SDK canonicalizes + hashes; we commit
    // the returned hash on chain.
    const sessionReplay = m.session.replay();
    const replay: Replay = {
      protocolVersion: "v0",
      matchId,
      gameId: GAME_ID,
      simulatorSha256: SIMULATOR_SHA,
      seed: sessionReplay.seed,
      initialState: sessionReplay.initialState,
      finalState: sessionReplay.finalState,
      inputs: sessionReplay.inputs,
      startedAt: Math.floor(Date.now() / 1000),
      endedAt: Math.floor(Date.now() / 1000),
    };
    const uploaded = await this.platform.uploadReplay({ replay });

    await this.platform.signAndPostOutcome({
      matchId,
      gameId: GAME_ID,
      winners,
      payoutShares,
      replayHash: uploaded.replayHash,
      idempotencyKey: `tic-tac-toe-${matchId}-outcome`,
    });
  }
}
