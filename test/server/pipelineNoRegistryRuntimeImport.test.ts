import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PIPELINE_DIR = path.resolve(import.meta.dir, "../../src/server/pipeline");

/**
 * Pipeline stages must be importable on their own: a runtime import of
 * ../toolRegistry forms a cycle (toolRegistry constructs the Default* stages),
 * so importing a stage first throws a TDZ ReferenceError. Type-only imports are
 * erased and safe.
 */
describe("pipeline modules", () => {
  const files = readdirSync(PIPELINE_DIR).filter((f) => f.endsWith(".ts"));

  test("there are pipeline modules to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} has no runtime import of ../toolRegistry`, () => {
      const source = readFileSync(path.join(PIPELINE_DIR, file), "utf8");
      const runtimeImports = [
        ...source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"\.\.\/toolRegistry";/gms),
      ].map((m) => m[0]);
      expect(runtimeImports).toEqual([]);
    });
  }
});
