import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRelativeImportPaths } from "../../scripts/lib/tsImportDeps";

describe("resolveRelativeImportPaths", () => {
  let repoRoot: string;

  beforeEach(() => {
    mkdirSync(path.join(process.cwd(), "scratch"), { recursive: true });
    repoRoot = mkdtempSync(path.join(process.cwd(), "scratch/ts-import-deps-"));
    mkdirSync(path.join(repoRoot, "scripts/release/lib"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, "scripts/release/pin-runtime-deps.ts"),
      [
        'import { roots } from "./lib/runtime-roots";',
        'import { pins } from "./lib/runtime-pins.ts";',
        'import "./lib/cycle-a";',
        'import packageName from "typescript";',
        'import { readFileSync } from "node:fs";',
        "void roots; void pins; void packageName; void readFileSync;",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repoRoot, "scripts/release/lib/runtime-roots.ts"),
      'export { nested } from "./nested";\n',
    );
    writeFileSync(
      path.join(repoRoot, "scripts/release/lib/runtime-pins.ts"),
      "export const pins = [];\n",
    );
    writeFileSync(path.join(repoRoot, "scripts/release/lib/nested.ts"), 'import "./cycle-a";\n');
    writeFileSync(path.join(repoRoot, "scripts/release/lib/cycle-a.ts"), 'import "./cycle-b";\n');
    writeFileSync(path.join(repoRoot, "scripts/release/lib/cycle-b.ts"), 'import "./cycle-a";\n');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("resolves relative imports through two levels without following packages or cycles", () => {
    expect(
      resolveRelativeImportPaths(path.join(repoRoot, "scripts/release/pin-runtime-deps.ts"), {
        repoRoot,
      }),
    ).toEqual([
      "scripts/release/lib/cycle-a.ts",
      "scripts/release/lib/cycle-b.ts",
      "scripts/release/lib/nested.ts",
      "scripts/release/lib/runtime-pins.ts",
      "scripts/release/lib/runtime-roots.ts",
    ]);
  });

  test("keeps a missing relative import in the dependency graph", () => {
    const entryFile = path.join(repoRoot, "scripts/release/missing-consumer.ts");
    writeFileSync(entryFile, 'import "./lib/deleted-helper";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/lib/deleted-helper.ts",
    ]);
  });
});
