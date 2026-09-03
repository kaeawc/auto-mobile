import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
// `oxlint --print-config` normally completes in milliseconds, but it can be
// delayed by concurrent test processes on a two-core CI host.
const CONFIG_READ_HOOK_TIMEOUT_MS = 20_000;

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
}, CONFIG_READ_HOOK_TIMEOUT_MS);

// Return the SINGLE override that gates `rule`, asserting the
// rule resolves through exactly one override. Using the first match alone would
// miss a later, broader override that also enables the rule (widening its
// scope), so uniqueness is part of the guarantee.
function scopedRuleOverride(rule: string): ResolvedOverride | undefined {
  const matches = config.overrides.filter((override) =>
    override.rules ? Object.prototype.hasOwnProperty.call(override.rules, rule) : false,
  );
  expect(matches.length, `${rule} must be gated by exactly one override`).toBe(1);
  return matches[0];
}

function expectScopedRule(rule: string, files: string[], severity: string): void {
  const override = scopedRuleOverride(rule);
  expect(override?.files).toEqual(files);
  expect(override?.rules?.[rule]).toBe(severity);
}

describe(".oxlintrc.json rule scoping (via oxlint --print-config)", () => {
  test("catch-convention and no-unknown-cast are scoped to src/**", () => {
    for (const rule of ["auto-mobile/catch-convention", "auto-mobile/no-unknown-cast"]) {
      expectScopedRule(rule, ["src/**/*.ts"], "warn");
    }
  });

  test("no-accumulator-foreach is scoped to src/** (not the whole tree)", () => {
    expectScopedRule("auto-mobile/no-accumulator-foreach", ["src/**/*.ts"], "deny");
  });

  test("stress-explicit-timeout is scoped to test/stress/**", () => {
    expectScopedRule("auto-mobile/stress-explicit-timeout", ["test/stress/**/*.ts"], "deny");
  });

  test("no-bare-expect is scoped to test/**", () => {
    expectScopedRule("auto-mobile/no-bare-expect", ["test/**/*.ts"], "deny");
  });

  test("no-explicit-any is scoped to the two correctness-sensitive navigation files", () => {
    expectScopedRule(
      "typescript/no-explicit-any",
      [
        "src/features/navigation/ScreenFingerprint.ts",
        "src/features/navigation/ExploreElementExtraction.ts",
      ],
      "deny",
    );
  });

  test("the raw-timer guard applies globally, with SystemTimer.ts exempted", () => {
    // `--print-config` omits top-level JavaScript-plugin rules, so run oxlint
    // against a temporary source file to prove the global rule is active.
    expectScopedRule("auto-mobile/no-raw-timer", ["**/SystemTimer.ts"], "allow");
  });

  test("the raw-timer guard is active outside its SystemTimer.ts exemption", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "auto-mobile-oxlint-"));
    const sourcePath = join(temporaryDirectory, "raw-timer.ts");
    try {
      await writeFile(sourcePath, "setTimeout(() => {}, 1);\n");
      const result = Bun.spawnSync({
        cmd: [
          join(ROOT, "node_modules", ".bin", "oxlint"),
          "--config",
          ".oxlintrc.json",
          sourcePath,
        ],
        cwd: ROOT,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toContain("auto-mobile(no-raw-timer)");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
