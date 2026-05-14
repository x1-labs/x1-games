// Player CLI for the TTT demo.
//
//   bun src/cli.ts create               — create a match, then play
//   bun src/cli.ts join <matchId>       — join an existing match, then play
//
// Env:
//   RPC_URL              — Solana RPC (default http://127.0.0.1:8899)
//   TTT_SERVER_HTTP      — TTT server HTTP base (default http://127.0.0.1:3002)
//   PLAYER_KEYPAIR       — path to JSON keypair file (default .local/player.json)
//
// Two terminals = two players. Each persists its keypair so re-runs keep the
// same player identity.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout, exit, argv } from "node:process";
import * as readline from "node:readline/promises";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Platform } from "@x1-labs/games-sdk";

const RPC_URL = process.env["RPC_URL"] ?? "http://127.0.0.1:8899";
const SERVER_HTTP = process.env["TTT_SERVER_HTTP"] ?? "http://127.0.0.1:3002";
const SERVER_WS = SERVER_HTTP.replace(/^http/, "ws") + "/play";

const cmd = argv[2];
const arg = argv[3];
if (cmd !== "create" && cmd !== "join") {
  console.error(
    "usage:\n" +
      "  bun src/cli.ts create               # create a new match and play\n" +
      "  bun src/cli.ts join <matchId>       # join an existing match\n",
  );
  exit(1);
}
if (cmd === "join" && !arg) {
  console.error("`join` requires a <matchId>");
  exit(1);
}

const KEYPAIR_PATH = resolve(process.env["PLAYER_KEYPAIR"] ?? ".local/player.json");
mkdirSync(resolve(KEYPAIR_PATH, ".."), { recursive: true });

function loadOrGenerate(path: string): Keypair {
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const player = loadOrGenerate(KEYPAIR_PATH);
console.log(`[ttt-cli] player: ${player.publicKey.toBase58()}`);

const connection = new Connection(RPC_URL, "confirmed");
const balance = await connection.getBalance(player.publicKey);
if (balance < 0.1 * LAMPORTS_PER_SOL) {
  console.log("[ttt-cli] airdropping 1 SOL...");
  const sig = await connection.requestAirdrop(player.publicKey, LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

const info = await fetch(`${SERVER_HTTP}/info`).then((r) => r.json() as Promise<{
  gameId: string;
  attestorPubkey: string;
  treasuryPubkey: string;
}>);
console.log(`[ttt-cli] server: gameId=${info.gameId} attestor=${info.attestorPubkey}`);

const platform = Platform.connect({ network: "x1-localnet", signer: player, rpcUrl: RPC_URL });

let matchId: string;
if (cmd === "create") {
  console.log("[ttt-cli] creating match...");
  const { matchId: id } = await platform.createMatch({
    gameId: info.gameId,
    seats: 2,
    stakePerSeat: "10000000", // 0.01 SOL per seat
    housePrize: null,
    rakeBps: 300,
    model: "TRUSTED",
    fundingDeadlineSec: 600,
    settlementDeadlineSec: 3600,
    attestor: info.attestorPubkey,
    treasury: info.treasuryPubkey,
  });
  matchId = id;
  console.log(`[ttt-cli] match created: ${matchId}`);
  console.log(`[ttt-cli] joining as creator...`);
  await platform.joinMatch({ matchId });
  console.log(`[ttt-cli] tell your opponent:  bun src/cli.ts join ${matchId}`);
} else {
  matchId = arg!;
  console.log(`[ttt-cli] joining match ${matchId}...`);
  await platform.joinMatch({ matchId });
}

// ----- WS connection ------------------------------------------------------

const ws = new WebSocket(SERVER_WS);
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res(), { once: true });
  ws.addEventListener("error", (e) => rej(e), { once: true });
});
ws.send(JSON.stringify({ type: "hello", matchId, player: player.publicKey.toBase58() }));

let mySymbol: "X" | "O" | null = null;
let lastState: {
  board: ReadonlyArray<string | null>;
  turn: "X" | "O";
  status: "in_progress" | "won" | "draw";
  winner: string | null;
  playerX: string;
  playerO: string;
} | null = null;

function render(): void {
  if (!lastState) return;
  const me = player.publicKey.toBase58();
  if (lastState.playerX === me) mySymbol = "X";
  else if (lastState.playerO === me) mySymbol = "O";

  console.clear();
  console.log(`match:  ${matchId}`);
  console.log(`me:     ${me.slice(0, 8)}…  (${mySymbol ?? "?"})`);
  console.log(`X:      ${lastState.playerX.slice(0, 8)}…`);
  console.log(`O:      ${lastState.playerO.slice(0, 8)}…`);
  console.log(`turn:   ${lastState.turn}${lastState.turn === mySymbol ? "  ← your move" : ""}`);
  console.log(`status: ${lastState.status}${lastState.winner ? `  winner=${lastState.winner.slice(0, 8)}…` : ""}`);
  console.log();
  const b = lastState.board;
  const cell = (c: string | null, i: number) => (c ?? String(i)).padStart(1);
  console.log(` ${cell(b[0]!, 0)} │ ${cell(b[1]!, 1)} │ ${cell(b[2]!, 2)} `);
  console.log(`───┼───┼───`);
  console.log(` ${cell(b[3]!, 3)} │ ${cell(b[4]!, 4)} │ ${cell(b[5]!, 5)} `);
  console.log(`───┼───┼───`);
  console.log(` ${cell(b[6]!, 6)} │ ${cell(b[7]!, 7)} │ ${cell(b[8]!, 8)} `);
  console.log();
}

ws.addEventListener("message", (ev) => {
  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(ev.data as string);
  } catch {
    return;
  }
  if (msg.type === "state") {
    lastState = msg as unknown as typeof lastState;
    render();
  } else if (msg.type === "settled") {
    console.log(`\n[ttt-cli] match settled on chain.`);
    if (msg["winner"]) console.log(`[ttt-cli] winner: ${msg["winner"]}`);
    else console.log(`[ttt-cli] draw — pot split.`);
    process.exit(0);
  } else if (msg.type === "error") {
    console.log(`[server error] ${msg["message"]}`);
  } else if (msg.type === "info") {
    console.log(`[server] ${msg["message"]}`);
  }
});

ws.addEventListener("close", () => {
  console.log("[ttt-cli] server disconnected");
  process.exit(0);
});

const rl = readline.createInterface({ input: stdin, output: stdout });
console.log("[ttt-cli] type a cell number 0-8 to play, or 'q' to quit");
for await (const line of rl) {
  const t = line.trim();
  if (t === "q") break;
  const cell = Number.parseInt(t, 10);
  if (Number.isNaN(cell) || cell < 0 || cell > 8) {
    console.log("[ttt-cli] enter 0-8");
    continue;
  }
  ws.send(JSON.stringify({ type: "move", cell }));
}
ws.close();
