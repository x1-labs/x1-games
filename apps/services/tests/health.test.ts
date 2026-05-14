import { describe, expect, test } from "bun:test";
import { Platform } from "@x1-labs/games-sdk";
import { appRouter } from "../src/router/index.ts";
import { createCallerFactory } from "../src/trpc.ts";

const createCaller = createCallerFactory(appRouter);

function stubContext() {
  return { platform: Platform.connect({ network: "stub" }) };
}

describe("health.get", () => {
  test("returns { status: 'ok', version: string }", async () => {
    const caller = createCaller(stubContext());
    const result = await caller.health.get();

    expect(result).toMatchObject({
      status: "ok",
      version: expect.any(String),
    });
  });

  test("version follows semver", async () => {
    const caller = createCaller(stubContext());
    const result = await caller.health.get();

    expect(result.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});
