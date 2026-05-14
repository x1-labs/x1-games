// Pure tic-tac-toe rules. Stateless, deterministic, immutable.

export type Player = "X" | "O";
export type Cell = Player | null;
export type Board = readonly [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];

export interface Move {
  readonly player: Player;
  readonly cell: number; // 0–8, row-major
}

export type Status = "in_progress" | "won" | "draw";

export interface GameState {
  readonly board: Board;
  readonly turn: Player;
  readonly winner: Player | null;
  readonly status: Status;
  readonly moves: readonly Move[];
}

const WIN_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],         // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8],         // cols
  [0, 4, 8], [2, 4, 6],                    // diagonals
];

const EMPTY_BOARD: Board = [null, null, null, null, null, null, null, null, null];

export function newGame(): GameState {
  return {
    board: EMPTY_BOARD,
    turn: "X",
    winner: null,
    status: "in_progress",
    moves: [],
  };
}

export function applyMove(state: GameState, move: Move): GameState {
  if (state.status !== "in_progress") {
    throw new Error(`game is in terminal state "${state.status}"`);
  }
  if (move.cell < 0 || move.cell > 8 || !Number.isInteger(move.cell)) {
    throw new Error(`cell ${move.cell} out of range (expected 0–8 integer)`);
  }
  if (move.player !== state.turn) {
    throw new Error(`not your turn — it is ${state.turn}'s turn, not ${move.player}'s`);
  }
  if (state.board[move.cell] !== null) {
    throw new Error(`cell ${move.cell} is already occupied by ${state.board[move.cell]}`);
  }

  const nextBoard = state.board.slice() as Cell[];
  nextBoard[move.cell] = move.player;
  const board = nextBoard as unknown as Board;

  const winner = detectWinner(board);
  const allFilled = board.every((c) => c !== null);
  const status: Status = winner ? "won" : allFilled ? "draw" : "in_progress";

  return {
    board,
    turn: move.player === "X" ? "O" : "X",
    winner,
    status,
    moves: [...state.moves, move],
  };
}

function detectWinner(board: Board): Player | null {
  for (const [a, b, c] of WIN_LINES) {
    const v = board[a];
    if (v != null && v === board[b] && v === board[c]) return v;
  }
  return null;
}
