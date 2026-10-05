import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Declared manifest of lint-chain configuration and baseline reads. Update it
// when lint.sh, oxlint-baseline.sh or a check-boundaries.sh consumer adds a read.
// Source/script trees are covered by turboLintInputsCoverScriptChain.test.ts.
const LINT_READ_FILES = {
  ".oxlintrc.json": "oxlint --fix and oxlint-baseline.sh",
  "oxlint-plugins/auto-mobile.mjs": "oxlint jsPlugins",
  "tsconfig.json": "oxlint type-aware ratchet",
  ".oxfmtrc.json": "oxfmt --write",
  ".editorconfig": "oxfmt option fallback",
  ".gitignore": "oxfmt default file discovery",
  "package.json": "Bun/tool dependency resolution and formatting",
  "bun.lock": "Bun/tool dependency versions",
  "turbo.json": "oxfmt formats the task configuration",
  "scripts/oxlint-baseline.txt": "oxlint-baseline.sh",
  "scripts/utils-import-direction-baseline.txt":
    "check-utils-import-direction.ts via check-boundaries.sh",
  "test/features/element-resolution/observeContractGaps.json":
    "check-element-resolution-ratchet.sh",
  "test/features/element-resolution/observeContractGapSignatures.json":
    "check-element-resolution-ratchet.sh",
  "test/features/element-resolution/observeContractCaseKeys.json":
    "check-element-resolution-ratchet.sh",
} as const;

function coveredBy(inputs: readonly string[], path: string): boolean {
  return (
    inputs.some((input) => !input.startsWith("!") && new Bun.Glob(input).match(path)) &&
    !inputs.some((input) => input.startsWith("!") && new Bun.Glob(input.slice(1)).match(path))
  );
}

describe("turbo lint inputs cover declared configuration and baseline reads", () => {
  const root = join(import.meta.dir, "../..");
  const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as {
    tasks: { lint: { inputs: string[]; env: string[] } };
  };

  test("every declared read exists and invalidates the lint cache", () => {
    const paths = Object.keys(LINT_READ_FILES);
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
    expect(paths.filter((path) => !coveredBy(turbo.tasks.lint.inputs, path))).toEqual([]);
  });

  test("configured oxlint plugins are represented in the manifest", () => {
    const config = Bun.JSONC.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8")) as {
      jsPlugins: string[];
    };
    expect(config.jsPlugins.length).toBeGreaterThan(0);
    expect(
      config.jsPlugins
        .map((path) => path.replace(/^\.\//, ""))
        .filter((path) => !(path in LINT_READ_FILES)),
    ).toEqual([]);
  });

  test("baseline globs are precise and turbo exclusions take precedence", () => {
    const path = "scripts/utils-import-direction-baseline.txt";
    expect(coveredBy(["scripts/*-baseline.txt"], path)).toBe(true);
    expect(coveredBy(["scripts/*-baseline.txt"], "scripts/nested/other-baseline.txt")).toBe(false);
    expect(coveredBy(["scripts/*-baseline.txt"], "scripts/not-a-baseline.json")).toBe(false);
    expect(coveredBy(["scripts/**", `!${path}`], path)).toBe(false);
    expect(coveredBy([`!${path}`, "scripts/**"], path)).toBe(false);
    expect(coveredBy(["scripts/oxlint-baseline.txt"], path)).toBe(false);
  });

  test("neighbouring lint inputs and PR base hashing remain intact", () => {
    expect(turbo.tasks.lint.inputs).toEqual(
      expect.arrayContaining(["src/**", "test/**", "scripts/**/*.ts", "scripts/**/*.sh"]),
    );
    expect(turbo.tasks.lint.env).toContain("GITHUB_BASE_REF");
  });
});
