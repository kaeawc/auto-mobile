import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");

describe("loadJimp", () => {
  test("does not load the WASM WebP plugin", () => {
    const source = readFileSync(path.join(repoRoot, "src/utils/image/loadJimp.ts"), "utf8");

    expect(source).not.toContain("@jimp/wasm-webp");
  });
});
