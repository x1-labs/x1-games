// Reliable handles for @coral-xyz/anchor and @solana/web3.js under any
// CJS/ESM interop mode ts-mocha + ts-node might pick.
//
// Background: depending on the host Node version, tsconfig compilation, and
// whether the default-import helper (`__importDefault`) is emitted, a CJS
// module like `@coral-xyz/anchor` may appear as the module itself OR as
// `{ default: theModule }`. Namespace import + a defensive `.default ?? ns`
// fallback handles both reliably.

import * as anchorNs from "@coral-xyz/anchor";
import * as web3Ns from "@solana/web3.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const anchor: any = (anchorNs as any).default ?? anchorNs;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const web3: any = (web3Ns as any).default ?? web3Ns;
