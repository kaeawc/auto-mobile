import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SOURCE_PATH = join(
  import.meta.dir,
  "../../../../src/features/observe/output/ObserveResultOutput.ts",
);

describe("ObserveResultOutput source integrity", () => {
  test("contains no literal ASCII control bytes beyond whitespace", () => {
    const source = readFileSync(SOURCE_PATH);
    const controls = source.filter((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13);
    expect(controls).toHaveLength(0);
  });
});
