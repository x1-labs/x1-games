import { describe, expect, test } from "bun:test";
import { canonicalJson, canonicalSha256, sha256Hex } from "../src/canonical";

describe("canonicalJson", () => {
  test("sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("preserves array order", () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  test("recurses into nested objects", () => {
    const v = { z: { b: 1, a: 2 }, a: { y: 1, x: 2 } };
    expect(canonicalJson(v)).toBe('{"a":{"x":2,"y":1},"z":{"a":2,"b":1}}');
  });

  test("two equivalent inputs produce identical bytes", () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  test("no insignificant whitespace", () => {
    expect(canonicalJson({ a: 1 })).not.toContain(" ");
    expect(canonicalJson({ a: 1 })).not.toContain("\n");
  });
});

describe("canonicalSha256", () => {
  test("returns 0x-prefixed 64 lowercase hex", () => {
    const h = canonicalSha256({ a: 1 });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("equivalent objects hash to the same value", () => {
    expect(canonicalSha256({ b: 1, a: 2 })).toBe(canonicalSha256({ a: 2, b: 1 }));
  });

  test("different objects hash to different values", () => {
    expect(canonicalSha256({ a: 1 })).not.toBe(canonicalSha256({ a: 2 }));
  });
});

describe("sha256Hex", () => {
  test("hashes empty string to the known SHA-256 of '' ", () => {
    expect(sha256Hex("")).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
