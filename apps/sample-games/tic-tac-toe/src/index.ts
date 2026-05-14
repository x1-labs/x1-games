// Public surface of @x1-labs/sample-tic-tac-toe.
// Consumers (e.g. integration tests) import from this entrypoint.

export { TttGameServer } from "./server.ts";
export { TttSession } from "./session.ts";
export { newGame, applyMove } from "./game.ts";
export type { Player, Cell, Board, Move, Status, GameState } from "./game.ts";
export type { SessionOptions, SessionReplay } from "./session.ts";
