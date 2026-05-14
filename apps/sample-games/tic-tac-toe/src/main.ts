// TTT game server — runs as a long-lived bun process.
//
// Responsibilities:
//   • Holds the dev/attestor keypair for the "tic-tac-toe" game.
//   • Registers the game on chain (idempotent).
//   • Accepts WebSocket connections from player CLIs.
//   • Drives sessions through TttGameServer; settles on chain at terminal.
//   • Exposes GET /info so player CLIs can discover gameId/attestor/treasury.
//
// Phase A1 of the playable demo. No auth: a player claims identity by pubkey
// in the WS hello and the server trusts the claim if it matches the on-chain
// match participants. SIWS-style auth lands in Phase A3.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Platform } from "@x1-labs/games-sdk";
import { TttGameServer } from "./server.ts";
import index from "../public/index.html";
import {
  DOMAIN,
  newNonce,
  verifyHello,
  type HelloMsg,
} from "./auth.ts";

const RPC_URL = process.env["RPC_URL"] ?? "http://127.0.0.1:8899";
const PORT = Number(process.env["PORT"] ?? 3002);
const DATA_DIR = resolve(process.env["DATA_DIR"] ?? ".local");
const GAME_ID = "tic-tac-toe";
const SIMULATOR_SHA = "0x" + "00".repeat(32);

mkdirSync(DATA_DIR, { recursive: true });

function loadOrGenerate(name: string): Keypair {
  const path = resolve(DATA_DIR, `${name}.json`);
  if (existsSync(path)) {
    const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const attestor = loadOrGenerate("attestor");
const treasury = loadOrGenerate("treasury");

const connection = new Connection(RPC_URL, "confirmed");

// Airdrop the attestor if it can't afford registration + match creation.
const balance = await connection.getBalance(attestor.publicKey);
if (balance < 0.5 * LAMPORTS_PER_SOL) {
  console.log(`[ttt-server] airdropping 2 SOL to attestor ${attestor.publicKey.toBase58()}...`);
  const sig = await connection.requestAirdrop(attestor.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}
// Ensure treasury exists so the chain can credit lamports to it on payout.
const tBalance = await connection.getBalance(treasury.publicKey);
if (tBalance === 0) {
  const sig = await connection.requestAirdrop(treasury.publicKey, 1);
  await connection.confirmTransaction(sig, "confirmed");
}

const platform = Platform.connect({
  network: "x1-localnet",
  signer: attestor,
  rpcUrl: RPC_URL,
});

console.log(`[ttt-server] registering game ${GAME_ID}...`);
const registered = await platform.registerGame({
  protocolVersion: "v0",
  id: GAME_ID,
  displayName: "Tic-Tac-Toe",
  tier: "DEMO",
  runtime: "MANAGED",
  attestationModels: ["TRUSTED"],
  seats: { min: 2, max: 2 },
  simulator: { kind: "server", sha256: SIMULATOR_SHA },
  devPubkey: attestor.publicKey.toBase58(),
  attestorPubkey: attestor.publicKey.toBase58(),
  revenueReceiver: attestor.publicKey.toBase58(),
  joinUrlTemplate: `ws://127.0.0.1:${PORT}/play?match={matchId}`,
  metadataUri: "https://example.test/ttt.json",
});
if (registered.attestorPubkey !== attestor.publicKey.toBase58()) {
  console.error(
    "[ttt-server] WARNING: on-chain registration has a different attestor",
    `(${registered.attestorPubkey}) than our local keypair`,
    `(${attestor.publicKey.toBase58()}). Settlement will fail. Reset chain state or use the matching keypair.`,
  );
  process.exit(1);
}

const game = new TttGameServer({ platform });

// ----- WebSocket session state -------------------------------------------

interface ConnData {
  matchId: string | null;
  player: string | null;
  /** Challenge issued to this connection. Cleared once a valid hello consumes it. */
  challenge: { nonce: string; timestamp: number } | null;
  /** True once a valid hello has been verified for this connection. */
  authed: boolean;
}

const connsByMatch = new Map<string, Set<Bun.ServerWebSocket<ConnData>>>();

function broadcast(matchId: string): void {
  const set = connsByMatch.get(matchId);
  if (!set || set.size === 0) return;
  const snap = game.snapshot(matchId);
  if (!snap) return;
  const payload = JSON.stringify({ type: "state", ...snap });
  for (const ws of set) ws.send(payload);
}

async function tryAttach(matchId: string): Promise<boolean> {
  try {
    const v = await platform.getMatch(matchId);
    if (v.state === "Live" && game.snapshot(matchId) === null) {
      await game.attachMatch(matchId);
      return true;
    }
    return game.snapshot(matchId) !== null;
  } catch {
    return false;
  }
}

// ----- HTTP + WebSocket server -------------------------------------------

const server = Bun.serve<ConnData>({
  port: PORT,
  development: process.env["NODE_ENV"] !== "production",
  routes: {
    // Bun bundles ./public/index.html plus the .ts/.css it references.
    "/": index,
  },
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/info") {
      return Response.json({
        gameId: GAME_ID,
        attestorPubkey: attestor.publicKey.toBase58(),
        treasuryPubkey: treasury.publicKey.toBase58(),
      });
    }
    if (url.pathname === "/play") {
      const ok = srv.upgrade(req, {
        data: { matchId: null, player: null, challenge: null, authed: false },
      });
      if (ok) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      // Issue a per-connection challenge immediately. Hello must echo this.
      const nonce = newNonce();
      const timestamp = Math.floor(Date.now() / 1000);
      ws.data.challenge = { nonce, timestamp };
      ws.send(JSON.stringify({ type: "challenge", nonce, timestamp, domain: DOMAIN }));
    },
    async message(ws, raw) {
      let msg: {
        type?: string;
        matchId?: string;
        player?: string;
        signature?: string;
        cell?: number;
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
        return;
      }

      if (msg.type === "hello") {
        if (ws.data.authed) {
          ws.send(JSON.stringify({ type: "error", message: "already authed" }));
          return;
        }
        if (!ws.data.challenge) {
          ws.send(JSON.stringify({ type: "error", message: "no active challenge" }));
          return;
        }
        if (!msg.matchId || !msg.player || !msg.signature) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "hello requires matchId, player, signature",
            }),
          );
          return;
        }

        let pubkeyBytes: Uint8Array;
        try {
          pubkeyBytes = new PublicKey(msg.player).toBytes();
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "player is not a valid pubkey" }));
          ws.close(1008, "bad pubkey");
          return;
        }
        const hello: HelloMsg = {
          type: "hello",
          matchId: msg.matchId,
          player: msg.player,
          signature: msg.signature,
        };
        const err = verifyHello(
          ws.data.challenge,
          hello,
          pubkeyBytes,
          Math.floor(Date.now() / 1000),
        );
        if (err) {
          ws.send(JSON.stringify({ type: "error", message: `auth: ${err}` }));
          ws.close(1008, "auth failed");
          return;
        }

        ws.data.matchId = msg.matchId;
        ws.data.player = msg.player;
        ws.data.authed = true;
        ws.data.challenge = null; // single-use

        let set = connsByMatch.get(msg.matchId);
        if (!set) {
          set = new Set();
          connsByMatch.set(msg.matchId, set);
        }
        set.add(ws);

        const attached = await tryAttach(msg.matchId);
        if (attached) {
          if (!game.isParticipant(msg.matchId, msg.player)) {
            ws.send(
              JSON.stringify({ type: "error", message: "not a participant of this match" }),
            );
          }
          broadcast(msg.matchId);
        } else {
          ws.send(
            JSON.stringify({
              type: "info",
              message: "waiting for both players to join on chain (state must be Live)",
            }),
          );
        }
        return;
      }

      if (!ws.data.authed) {
        ws.send(JSON.stringify({ type: "error", message: "not authenticated; send hello first" }));
        return;
      }

      if (msg.type === "move") {
        const { matchId, player } = ws.data;
        if (!matchId || !player) {
          ws.send(JSON.stringify({ type: "error", message: "missing match/player binding" }));
          return;
        }
        if (msg.cell === undefined) {
          ws.send(JSON.stringify({ type: "error", message: "move requires cell" }));
          return;
        }
        try {
          await game.submitMove({ matchId, player, cell: msg.cell });
          broadcast(matchId);
          const snap = game.snapshot(matchId);
          if (snap && snap.settled) {
            const finalPayload = JSON.stringify({ type: "settled", matchId, winner: snap.winner });
            for (const c of connsByMatch.get(matchId) ?? []) c.send(finalPayload);
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
        }
        return;
      }
      ws.send(JSON.stringify({ type: "error", message: `unknown type: ${msg.type}` }));
    },
    close(ws) {
      const matchId = ws.data.matchId;
      if (matchId) connsByMatch.get(matchId)?.delete(ws);
    },
  },
});

console.log(`[ttt-server] listening on http://127.0.0.1:${server.port}`);
console.log(`[ttt-server]   gameId:    ${GAME_ID}`);
console.log(`[ttt-server]   attestor:  ${attestor.publicKey.toBase58()}`);
console.log(`[ttt-server]   treasury:  ${treasury.publicKey.toBase58()}`);
