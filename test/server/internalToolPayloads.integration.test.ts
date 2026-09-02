import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("asToolEnvelope is eliminated from src (AC2 source scan)", () => {
  test("no src/ file references asToolEnvelope", () => {
    const srcDir = join(import.meta.dir, "..", "..", "src");
    const offenders = collectTsFiles(srcDir).filter((file) =>
      readFileSync(file, "utf8").includes("asToolEnvelope"),
    );
    expect(offenders).toEqual([]);
  });
});
