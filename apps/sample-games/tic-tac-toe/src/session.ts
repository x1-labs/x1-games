// Session = one tic-tac-toe match. Binds player pubkeys to symbols, accepts
// moves identified by pubkey, exposes terminal state and replay material.

import { newGame, applyMove, type GameState, type Player } from "./game.ts";

export interface SessionOptions {
  readonly matchId: string;
  readonly players: readonly [string, string]; // [X, O]
  readonly seed: string;                        // 0x + 16 hex; per INTEGRATION.md
}

export interface SessionReplay {
  matchId: string;
  seed: string;
  inputs: Array<{ tick: number; playerIndex: number; data: { cell: number } }>;
  initialState: { board: GameState["board"]; turn: Player };
  finalState: { board: GameState["board"]; status: GameState["status"]; winner: GameState["winner"] };
}

export class TttSession {
  readonly matchId: string;
  readonly players: readonly [string, string];
  readonly seed: string;
  private game: GameState;
  private readonly bySymbol: Record<Player, string>;
  private readonly byPubkey: Record<string, Player>;
  private readonly initial: { board: GameState["board"]; turn: Player };

  constructor(opts: SessionOptions) {
    this.matchId = opts.matchId;
    this.players = opts.players;
    this.seed = opts.seed;
    this.game = newGame();
    this.bySymbol = { X: opts.players[0], O: opts.players[1] };
    this.byPubkey = { [opts.players[0]]: "X", [opts.players[1]]: "O" };
    this.initial = { board: this.game.board, turn: this.game.turn };
  }

  get state(): GameState {
    return this.game;
  }

  symbolFor(pubkey: string): Player {
    const sym = this.byPubkey[pubkey];
    if (!sym) throw new Error(`${pubkey} is not a participant in match ${this.matchId}`);
    return sym;
  }

  submitMove(input: { player: string; cell: number }): GameState {
    const sym = this.symbolFor(input.player);
    this.game = applyMove(this.game, { player: sym, cell: input.cell });
    return this.game;
  }

  isTerminal(): boolean {
    return this.game.status !== "in_progress";
  }

  winnerPubkey(): string | null {
    if (!this.game.winner) return null;
    return this.bySymbol[this.game.winner];
  }

  replay(): SessionReplay {
    return {
      matchId: this.matchId,
      seed: this.seed,
      initialState: this.initial,
      finalState: {
        board: this.game.board,
        status: this.game.status,
        winner: this.game.winner,
      },
      inputs: this.game.moves.map((m, i) => ({
        tick: i,
        playerIndex: m.player === "X" ? 0 : 1,
        data: { cell: m.cell },
      })),
    };
  }
}
