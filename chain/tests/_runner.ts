// Mocha runner driven from bun's programmatic API.
//
// Why this exists: `bunx mocha` resolves mocha's bin but the bin's shebang
// (`#!/usr/bin/env node`) means Node ends up executing mocha. On Linux CI
// runners with newer Node, mocha then can't load `.ts` files at all
// (ERR_UNKNOWN_FILE_EXTENSION) or trips over CJS↔ESM interop in ways that
// don't reproduce on Mac with bun's bundled toolchain.
//
// Running `bun chain/tests/_runner.ts` guarantees bun is the interpreter.
// Bun handles TypeScript natively, no loader hooks needed, behaviour is
// platform-consistent.

import Mocha from "mocha";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const mocha = new Mocha({
  timeout: 120_000,
  reporter: "spec",
});

const specFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith(".spec.ts"))
  .sort()
  .map((f) => join(__dirname, f));

for (const f of specFiles) mocha.addFile(f);

mocha.run((failures) => {
  process.exit(failures > 0 ? 1 : 0);
});
