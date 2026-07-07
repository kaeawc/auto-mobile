import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");

describe("WebP dependency tree", () => {
  test("does not include @jimp/wasm-webp", () => {
    const packageJson = readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const bunLock = readFileSync(path.join(repoRoot, "bun.lock"), "utf8");

    expect(packageJson).not.toContain("@jimp/wasm-webp");
    expect(bunLock).not.toContain("@jimp/wasm-webp");
  });
});
