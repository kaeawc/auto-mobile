import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseGuardSource } from "../../lint/astGuard";
import { collectSourceFacts } from "../../lint/sourceFacts";

const repoRoot = path.resolve(import.meta.dir, "../../..");

describe("loadJimp", () => {
  test("does not load the WASM WebP plugin", () => {
    const file = path.join(repoRoot, "src/utils/image/loadJimp.ts");
    const { moduleSpecifiers, stringLiterals } = collectSourceFacts(
      parseGuardSource(file, readFileSync(file, "utf8")),
    );

    // Non-vacuous: the loader still imports the plugins it does use.
    expect(moduleSpecifiers).toContain("@jimp/core");
    expect(moduleSpecifiers).not.toContain("@jimp/wasm-webp");
    // The previous source-text guard also caught a specifier built or held in a variable.
    expect(stringLiterals.filter((value) => value.includes("wasm-webp"))).toEqual([]);
  });
});
