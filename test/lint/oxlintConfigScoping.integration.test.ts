import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// The custom rules' file-scoping used to be enforced (and tested) through
// eslint.config.mjs's `files:` globs. Under oxlint that scoping lives in
// .oxlintrc.json's `overrides`, so the "does not apply outside <glob>"
// guarantees that bareExpectRule / accumulatorForEachRule / stressExplicitTimeout
// used to assert are now asserted here.
//
// Rather than parse .oxlintrc.json ourselves (it is JSONC — comments would break
// a naive JSON.parse), we read oxlint's OWN resolved configuration via
// `oxlint --print-config`, which emits strict JSON. That checks the declared
// override ownership and severities; fixture linting below proves the globs are
// applied to files in each configured scope.

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

function lintFixture(path: string) {
  return Bun.spawnSync({
    cmd: [join(ROOT, "node_modules", ".bin", "oxlint"), "--config", ".oxlintrc.json", path],
    cwd: ROOT,
  });
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

  test("configured globs apply to linted src, test, and stress fixtures", async () => {
    const sourceDirectory = await mkdtemp(join(ROOT, "src/oxlint-scoping-"));
    const testDirectory = await mkdtemp(join(ROOT, "test/oxlint-scoping-"));
    const stressDirectory = await mkdtemp(join(ROOT, "test/stress/oxlint-scoping-"));
    const sourceAccumulator = join(sourceDirectory, "accumulator.ts");
    const testAccumulator = join(testDirectory, "accumulator.ts");
    const sourceBareExpect = join(sourceDirectory, "bare-expect.ts");
    const testBareExpect = join(testDirectory, "bare-expect.ts");
    const regularTimeout = join(testDirectory, "timeout.test.ts");
    const stressTimeout = join(stressDirectory, "timeout.test.ts");
    const accumulator = `const output: string[] = [];
["item"].forEach((item) => {
  output.push(item);
});
`;
    const bareExpect = "expect(true);\n";
    const missingTimeout = `import { test } from "bun:test";
test("fixture", async () => {
  await Promise.resolve();
});
`;

    try {
      await Promise.all([
        writeFile(sourceAccumulator, accumulator),
        writeFile(testAccumulator, accumulator),
        writeFile(sourceBareExpect, bareExpect),
        writeFile(testBareExpect, bareExpect),
        writeFile(regularTimeout, missingTimeout),
        writeFile(stressTimeout, missingTimeout),
      ]);

      const sourceAccumulatorResult = lintFixture(relative(ROOT, sourceAccumulator));
      expect(sourceAccumulatorResult.exitCode).toBe(1);
      expect(sourceAccumulatorResult.stdout.toString()).toContain(
        "auto-mobile(no-accumulator-foreach)",
      );

      const testAccumulatorResult = lintFixture(relative(ROOT, testAccumulator));
      expect(testAccumulatorResult.exitCode).toBe(0);

      const sourceBareExpectResult = lintFixture(relative(ROOT, sourceBareExpect));
      expect(sourceBareExpectResult.exitCode).toBe(0);

      const testBareExpectResult = lintFixture(relative(ROOT, testBareExpect));
      expect(testBareExpectResult.exitCode).toBe(1);
      expect(testBareExpectResult.stdout.toString()).toContain("auto-mobile(no-bare-expect)");

      const regularTimeoutResult = lintFixture(relative(ROOT, regularTimeout));
      expect(regularTimeoutResult.exitCode).toBe(0);

      const stressTimeoutResult = lintFixture(relative(ROOT, stressTimeout));
      expect(stressTimeoutResult.exitCode).toBe(1);
      expect(stressTimeoutResult.stdout.toString()).toContain(
        "auto-mobile(stress-explicit-timeout)",
      );
    } finally {
      await Promise.all([
        rm(sourceDirectory, { recursive: true, force: true }),
        rm(testDirectory, { recursive: true, force: true }),
        rm(stressDirectory, { recursive: true, force: true }),
      ]);
    }
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
