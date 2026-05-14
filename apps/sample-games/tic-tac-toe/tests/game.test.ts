import { describe, expect, test } from "bun:test";
import { newGame, applyMove, type GameState, type Player } from "../src/game";

function play(moves: number[]): GameState {
  let s = newGame();
  for (const cell of moves) s = applyMove(s, { player: s.turn, cell });
  return s;
}

describe("newGame", () => {
  test("returns empty board with X to move", () => {
    const s = newGame();
    expect(s.board).toEqual([null, null, null, null, null, null, null, null, null]);
    expect(s.turn).toBe("X");
    expect(s.status).toBe("in_progress");
    expect(s.winner).toBeNull();
    expect(s.moves).toHaveLength(0);
  });
});

describe("applyMove", () => {
  test("places X at cell 4 and flips turn to O", () => {
    const s = applyMove(newGame(), { player: "X", cell: 4 });
    expect(s.board[4]).toBe("X");
    expect(s.turn).toBe("O");
    expect(s.moves).toEqual([{ player: "X", cell: 4 }]);
  });

  test("alternates X and O", () => {
    const s = play([0, 4, 1]);
    expect(s.board[0]).toBe("X");
    expect(s.board[4]).toBe("O");
    expect(s.board[1]).toBe("X");
    expect(s.turn).toBe("O");
  });

  test("rejects move when it is not the player's turn", () => {
    const s = newGame();
    expect(() => applyMove(s, { player: "O", cell: 0 })).toThrow(/not your turn/i);
  });

  test("rejects move on an occupied cell", () => {
    const s = applyMove(newGame(), { player: "X", cell: 0 });
    expect(() => applyMove(s, { player: "O", cell: 0 })).toThrow(/occupied/i);
  });

  test("rejects move out of range", () => {
    const s = newGame();
    expect(() => applyMove(s, { player: "X", cell: 9 })).toThrow(/range/i);
    expect(() => applyMove(s, { player: "X", cell: -1 })).toThrow(/range/i);
  });

  test("rejects move on a terminal game", () => {
    // X wins row 0
    const s = play([0, 3, 1, 4, 2]);
    expect(s.status).toBe("won");
    expect(() => applyMove(s, { player: "O", cell: 5 })).toThrow(/terminal/i);
  });
});

describe("terminal detection", () => {
  test("detects row win", () => {
    // X plays 0,1,2 (row 0); O plays 3,4
    const s = play([0, 3, 1, 4, 2]);
    expect(s.status).toBe("won");
    expect(s.winner).toBe("X");
  });

  test("detects column win", () => {
    // X plays 0,3,6 (col 0); O plays 1,4
    const s = play([0, 1, 3, 4, 6]);
    expect(s.status).toBe("won");
    expect(s.winner).toBe("X");
  });

  test("detects diagonal win (top-left to bottom-right)", () => {
    // X: 0,4,8; O: 1,2
    const s = play([0, 1, 4, 2, 8]);
    expect(s.status).toBe("won");
    expect(s.winner).toBe("X");
  });

  test("detects diagonal win (top-right to bottom-left)", () => {
    // X: 2,4,6; O: 0,1
    const s = play([2, 0, 4, 1, 6]);
    expect(s.status).toBe("won");
    expect(s.winner).toBe("X");
  });

  test("detects draw on full board with no winner", () => {
    // Classic stalemate
    //  X | O | X
    //  X | X | O
    //  O | X | O
    const s = play([0, 1, 2, 5, 4, 8, 3, 6, 7]);
    expect(s.status).toBe("draw");
    expect(s.winner).toBeNull();
    expect(s.board.filter((c) => c === null)).toHaveLength(0);
  });

  test("game remains in_progress until terminal", () => {
    const s = play([4, 0, 8]);
    expect(s.status).toBe("in_progress");
    expect(s.winner).toBeNull();
  });
});

describe("immutability", () => {
  test("applyMove does not mutate the input state", () => {
    const s0 = newGame();
    const s1 = applyMove(s0, { player: "X", cell: 0 });
    expect(s0.board[0]).toBeNull();
    expect(s1.board[0]).toBe("X");
    expect(s0).not.toBe(s1);
  });
});
