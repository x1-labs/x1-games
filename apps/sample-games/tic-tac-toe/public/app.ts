// Browser-side TTT client.
//
// Ephemeral wallet: a Solana keypair generated on first visit and persisted
// to localStorage. The browser uses Anchor + web3.js directly to call
// createMatch/joinMatch — no SDK in the browser (the SDK has Node deps).
//
// Live game traffic: same WebSocket protocol the CLI uses (hello/move/state).

// Browser node-shim. Must run BEFORE anchor/web3 modules evaluate, so it
// lives ahead of every other import. Bun's HTML dev-mode bundler doesn't
// auto-polyfill Buffer/process the way `bun build --target=browser` does.
import { Buffer } from "buffer";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Buffer = Buffer;

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import matchIdl from "../../../../packages/games-sdk/src/idl/match_program.json";
import { signHello } from "../src/auth.ts";

const MATCH_PROGRAM_ID = new PublicKey("kPnK69DwUAmEobyLiWNNmra6STdJLFszJxc314XkEKb");
const GAME_REGISTRY_PROGRAM_ID = new PublicKey("92NzjeGS2kEuLw53vAvox6eFdNfT2VoSTrSX4uGTHKbS");

const RPC_URL = "http://127.0.0.1:8899";
const WS_URL = location.origin.replace(/^http/, "ws") + "/play";

// ----- wallet -----------------------------------------------------------

const WALLET_KEY = "x1-ttt-wallet-v1";

function loadOrGenerate(): Keypair {
  const raw = localStorage.getItem(WALLET_KEY);
  if (raw) {
    try {
      const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
      return Keypair.fromSecretKey(bytes);
    } catch {
      // fall through
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(WALLET_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

function resetWallet(): Keypair {
  localStorage.removeItem(WALLET_KEY);
  return loadOrGenerate();
}

let player = loadOrGenerate();
const connection = new Connection(RPC_URL, "confirmed");

// ----- DOM helpers ------------------------------------------------------

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const playerPubkeyEl = $("player-pubkey");
const playerBalanceEl = $("player-balance");
const serverInfoEl = $("server-info");
const lobbyPanel = $("lobby-panel");
const matchPanel = $("match-panel");
const matchIdEl = $("match-id");
const playersInfoEl = $("players-info");
const statusEl = $("status");
const gridEl = $("grid") as HTMLDivElement;
const logEl = $("log");

function log(line: string): void {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${line}\n` + logEl.textContent;
}

function abbrev(s: string): string {
  return s.length > 14 ? s.slice(0, 6) + "…" + s.slice(-4) : s;
}

async function refreshBalance(): Promise<void> {
  try {
    const lamports = await connection.getBalance(player.publicKey);
    playerBalanceEl.textContent = `${(lamports / LAMPORTS_PER_SOL).toFixed(3)} SOL`;
  } catch {
    playerBalanceEl.textContent = "—";
  }
}

function renderWallet(): void {
  playerPubkeyEl.textContent = player.publicKey.toBase58();
  refreshBalance();
}

renderWallet();

$("airdrop").addEventListener("click", async () => {
  log("requesting airdrop…");
  try {
    const sig = await connection.requestAirdrop(player.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    log(`airdropped 1 SOL · ${abbrev(sig)}`);
  } catch (e) {
    log(`airdrop failed: ${(e as Error).message}`);
  }
  refreshBalance();
});

$("reset-wallet").addEventListener("click", () => {
  player = resetWallet();
  renderWallet();
  log("new wallet generated");
});

// ----- server discovery -------------------------------------------------

interface ServerInfo {
  gameId: string;
  attestorPubkey: string;
  treasuryPubkey: string;
}

let info: ServerInfo | null = null;

async function loadInfo(): Promise<void> {
  try {
    const res = await fetch("/info");
    info = (await res.json()) as ServerInfo;
    serverInfoEl.classList.remove("muted");
    serverInfoEl.textContent = `gameId=${info.gameId} · attestor=${abbrev(info.attestorPubkey)}`;
  } catch (e) {
    log(`/info failed: ${(e as Error).message}`);
  }
}
await loadInfo();

// ----- Anchor wiring ----------------------------------------------------

class BrowserWallet implements anchor.Wallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() {
    return this.payer.publicKey;
  }
  async signTransaction<T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(tx: T): Promise<T> {
    if ((tx as anchor.web3.VersionedTransaction).version !== undefined) {
      (tx as anchor.web3.VersionedTransaction).sign([this.payer]);
    } else {
      (tx as anchor.web3.Transaction).partialSign(this.payer);
    }
    return tx;
  }
  async signAllTransactions<T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((t) => this.signTransaction(t)));
  }
}

function getProgram(): anchor.Program {
  const provider = new anchor.AnchorProvider(connection, new BrowserWallet(player), {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new anchor.Program(matchIdl as any, provider);
}

function gameIdToPubkey(id: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("game"), Buffer.from(id)],
    GAME_REGISTRY_PROGRAM_ID,
  )[0];
}

function deriveMatchPda(gamePda: PublicKey, nonce: anchor.BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("match"), gamePda.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
    MATCH_PROGRAM_ID,
  )[0];
}

function deriveVaultPda(matchPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), matchPda.toBuffer()],
    MATCH_PROGRAM_ID,
  )[0];
}

// ----- chain operations -------------------------------------------------

async function createMatch(): Promise<string> {
  if (!info) throw new Error("server info not loaded");
  const program = getProgram();
  const gamePda = gameIdToPubkey(info.gameId);
  const nonce = new anchor.BN(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const matchPda = deriveMatchPda(gamePda, nonce);
  const vaultPda = deriveVaultPda(matchPda);
  const now = Math.floor(Date.now() / 1000);

  await program.methods
    .createMatch({
      nonce,
      seats: 2,
      stakePerSeat: new anchor.BN(10_000_000),
      rakeBps: 300,
      fundingDeadline: new anchor.BN(now + 600),
      settlementDeadline: new anchor.BN(now + 3600),
      model: { trusted: {} },
      attestor: new PublicKey(info.attestorPubkey),
      treasury: new PublicKey(info.treasuryPubkey),
      challengeWindowSecs: 0,
    })
    .accounts({
      game: gamePda,
      matchAccount: matchPda,
      vault: vaultPda,
      creator: player.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return matchPda.toBase58();
}

async function joinMatch(matchId: string): Promise<void> {
  const program = getProgram();
  const matchPda = new PublicKey(matchId);
  const vaultPda = deriveVaultPda(matchPda);
  await program.methods
    .joinMatch()
    .accounts({
      matchAccount: matchPda,
      vault: vaultPda,
      player: player.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

// ----- lobby buttons ----------------------------------------------------

$("btn-create").addEventListener("click", async () => {
  if (!info) {
    log("server /info not loaded yet");
    return;
  }
  try {
    log("creating match…");
    const matchId = await createMatch();
    log(`match created: ${matchId}`);
    log("joining as creator…");
    await joinMatch(matchId);
    log("joined; opening session");
    connectWS(matchId);
  } catch (e) {
    log(`create failed: ${(e as Error).message}`);
  }
});

$("btn-join").addEventListener("click", async () => {
  const matchId = ($("input-join") as HTMLInputElement).value.trim();
  if (!matchId) {
    log("paste a matchId first");
    return;
  }
  try {
    log(`joining ${abbrev(matchId)}…`);
    await joinMatch(matchId);
    log("joined; opening session");
    connectWS(matchId);
  } catch (e) {
    log(`join failed: ${(e as Error).message}`);
  }
});

// ----- WebSocket session -----------------------------------------------

let mySymbol: "X" | "O" | null = null;

interface StateMsg {
  matchId: string;
  board: ReadonlyArray<string | null>;
  turn: "X" | "O";
  status: "in_progress" | "won" | "draw";
  winner: string | null;
  playerX: string;
  playerO: string;
  seats: number;
  settled: boolean;
}

function connectWS(matchId: string): void {
  lobbyPanel.hidden = true;
  matchPanel.hidden = false;
  matchIdEl.textContent = matchId;
  buildGrid();

  const ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => log("ws open · waiting for challenge"));
  ws.addEventListener("close", () => log("ws close"));
  ws.addEventListener("message", (ev) => {
    let msg: { type?: string; message?: string; winner?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "challenge") {
      const nonce = msg["nonce"] as string;
      const ts = msg["timestamp"] as number;
      log(`signing challenge · nonce=${nonce.slice(0, 8)}…`);
      const signature = signHello(
        nonce,
        ts,
        matchId,
        player.publicKey.toBase58(),
        player.secretKey,
      );
      ws.send(
        JSON.stringify({
          type: "hello",
          matchId,
          player: player.publicKey.toBase58(),
          signature,
        }),
      );
      return;
    }
    if (msg.type === "state") render(msg as unknown as StateMsg);
    else if (msg.type === "settled") {
      log(`settled · winner=${msg.winner ? abbrev(msg.winner) : "draw"}`);
      refreshBalance();
    } else if (msg.type === "info") log(`server: ${msg.message}`);
    else if (msg.type === "error") log(`server error: ${msg.message}`);
  });

  function move(cell: number): void {
    ws.send(JSON.stringify({ type: "move", cell }));
  }

  function buildGrid(): void {
    gridEl.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const c = document.createElement("div");
      c.className = "cell";
      c.dataset["i"] = String(i);
      c.addEventListener("click", () => {
        if (c.classList.contains("taken") || c.classList.contains("terminal")) return;
        move(i);
      });
      gridEl.appendChild(c);
    }
  }

  function render(s: StateMsg): void {
    const me = player.publicKey.toBase58();
    if (s.playerX === me) mySymbol = "X";
    else if (s.playerO === me) mySymbol = "O";

    playersInfoEl.textContent = `${abbrev(s.playerX)} (X)  vs  ${abbrev(s.playerO)} (O)`;

    gridEl.classList.toggle("terminal", s.status !== "in_progress");
    for (let i = 0; i < 9; i++) {
      const c = gridEl.children[i] as HTMLDivElement;
      const v = s.board[i];
      c.textContent = v ?? "";
      c.classList.toggle("taken", v !== null);
      c.classList.toggle("x", v === "X");
      c.classList.toggle("o", v === "O");
    }

    if (s.status === "in_progress") {
      const yourMove = s.turn === mySymbol;
      statusEl.className = "status";
      statusEl.textContent = yourMove ? `your move (${mySymbol})` : `${s.turn} to move`;
    } else if (s.status === "won") {
      const youWon = s.winner === me;
      statusEl.className = "status win";
      statusEl.textContent = youWon ? "you win" : "you lose";
    } else {
      statusEl.className = "status draw";
      statusEl.textContent = "draw — pot split";
    }
  }
}
