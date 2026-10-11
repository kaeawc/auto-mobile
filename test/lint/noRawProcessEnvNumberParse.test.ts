import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// #11629: `parseInt(process.env.X)` accepts "30abc" and "2m"; numeric env reads go through
// src/utils/envNumbers.ts. Scanning every src file can exceed Bun's default hook limit on CI.
const SRC_DIR = path.join(import.meta.dir, "..", "..", "src");
const SCAN_HOOK_TIMEOUT_MS = 20_000;
const RAW_PARSE = /\b(?:Number\.)?(?:parseInt|parseFloat|Number)\(\s*process\.env\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith(".ts") ? [file] : [];
  });
}

describe("numeric env reads", () => {
  let offenders: string[] = [];

  beforeAll(() => {
    offenders = sourceFiles(SRC_DIR).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          RAW_PARSE.test(line) ? [`${path.relative(SRC_DIR, file)}:${index + 1}`] : [],
        ),
    );
  }, SCAN_HOOK_TIMEOUT_MS);

  test("the pattern flags the raw forms it exists to ban", () => {
    expect(RAW_PARSE.test("parseInt(process.env.X, 10)")).toBe(true);
    expect(RAW_PARSE.test("Number.parseInt(process.env.X)")).toBe(true);
    expect(RAW_PARSE.test("const n = Number(process.env.X) || 5")).toBe(true);
    expect(RAW_PARSE.test("readEnvPositiveInteger('X', undefined, { fallback: 5 })")).toBe(false);
  });

  test("src/ has no raw parseInt/Number over process.env", () => {
    expect(offenders).toEqual([]);
  });
});
