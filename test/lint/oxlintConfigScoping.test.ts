import { describe, expect, test, beforeAll } from "bun:test";
import { join } from "node:path";

// The custom rules' file-scoping used to be enforced (and tested) through
// eslint.config.mjs's `files:` globs. Under oxlint that scoping lives in
// .oxlintrc.json's `overrides`, so the "does not apply outside <glob>"
// guarantees that bareExpectRule / accumulatorForEachRule / stressExplicitTimeout
// used to assert are now asserted here.
//
// Rather than parse .oxlintrc.json ourselves (it is JSONC — comments would break
// a naive JSON.parse), we read oxlint's OWN resolved configuration via
// `oxlint --print-config`, which emits strict JSON. That is the tool's typed
// configuration contract and reflects exactly what oxlint will enforce.

const ROOT = join(import.meta.dir, "..", "..");

interface ResolvedOverride {
  files: string[];
  rules?: Record<string, unknown>;
}
interface ResolvedConfig {
  overrides: ResolvedOverride[];
}

let config: ResolvedConfig;

beforeAll(() => {
  const result = Bun.spawnSync({
    cmd: [join(ROOT, "node_modules", ".bin", "oxlint"), "--print-config"],
    cwd: ROOT,
  });
  if (result.exitCode !== 0) {
    throw new Error(`oxlint --print-config failed: ${result.stderr.toString()}`);
  }
  config = JSON.parse(result.stdout.toString()) as ResolvedConfig;
});

// Return the `files` of the SINGLE override that gates `rule`, asserting the
// rule resolves through exactly one override. Using the first match alone would
// miss a later, broader override that also enables the rule (widening its
// scope), so uniqueness is part of the guarantee.
function filesScopingRule(rule: string): string[] | undefined {
  const matches = config.overrides.filter((o) =>
    o.rules ? Object.prototype.hasOwnProperty.call(o.rules, rule) : false,
  );
  expect(matches.length, `${rule} must be gated by exactly one override`).toBe(1);
  return matches[0]?.files;
}

describe(".oxlintrc.json rule scoping (via oxlint --print-config)", () => {
  test("catch-convention and no-unknown-cast are scoped to src/**", () => {
    for (const rule of ["auto-mobile/catch-convention", "auto-mobile/no-unknown-cast"]) {
      expect(filesScopingRule(rule)).toEqual(["src/**/*.ts"]);
    }
  });

  test("no-accumulator-foreach is scoped to src/** (not the whole tree)", () => {
    expect(filesScopingRule("auto-mobile/no-accumulator-foreach")).toEqual(["src/**/*.ts"]);
  });

  test("stress-explicit-timeout is scoped to test/stress/**", () => {
    expect(filesScopingRule("auto-mobile/stress-explicit-timeout")).toEqual([
      "test/stress/**/*.ts",
    ]);
  });

  test("no-bare-expect is scoped to test/**", () => {
    expect(filesScopingRule("auto-mobile/no-bare-expect")).toEqual(["test/**/*.ts"]);
  });

  test("no-explicit-any is scoped to the two correctness-sensitive navigation files", () => {
    expect(filesScopingRule("typescript/no-explicit-any")).toEqual([
      "src/features/navigation/ScreenFingerprint.ts",
      "src/features/navigation/ExploreElementExtraction.ts",
    ]);
  });

  test("the raw-timer guard applies globally, with SystemTimer.ts exempted", () => {
    // no-raw-timer is enabled at the top level (so tests/scripts are covered) and
    // only turned OFF in the SystemTimer.ts override — that override is the sole
    // place it appears in the resolved overrides.
    expect(filesScopingRule("auto-mobile/no-raw-timer")).toEqual(["**/SystemTimer.ts"]);
  });
});
