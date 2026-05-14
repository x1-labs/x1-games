import { Hono } from "hono";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Platform } from "@x1-labs/games-sdk";
import web3 from "@solana/web3.js";
import { appRouter } from "./router/index.ts";
import { createContextFactory } from "./context.ts";

// The platform-side actor for the services tier. Chain reads don't strictly
// need a real signer, but the SDK requires one; we generate a session keypair
// at startup. Writes from the service (if/when we add them) would need a key
// material story — out of scope for v0.
const sessionSigner = web3.Keypair.generate();

const network = (process.env["X1_NETWORK"] as Parameters<typeof Platform.connect>[0]["network"]) ?? "stub";
const rpcUrl = process.env["X1_RPC_URL"];

const platform = Platform.connect(
  network === "stub"
    ? { network: "stub", signer: sessionSigner }
    : { network, signer: sessionSigner, ...(rpcUrl ? { rpcUrl } : {}) },
);

const createContext = createContextFactory({ platform });

const app = new Hono();
app.all("/trpc/*", (c) =>
  fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  }),
);

const port = Number(process.env["PORT"] ?? 3001);

export default {
  port,
  fetch: app.fetch,
};

export { appRouter };
export type { AppRouter } from "./router/index.ts";
