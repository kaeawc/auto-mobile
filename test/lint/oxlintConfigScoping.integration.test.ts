import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

// The custom rules' file-scoping used to be enforced (and tested) through
// eslint.config.mjs's `files:` globs. Under oxlint that scoping lives in
// .oxlintrc.json's `overrides`, so the "does not apply outside <glob>"
// guarantees that bareExpectRule / accumulatorForEachRule / stressExplicitTimeout
// used to assert are now asserted here.
//
// Read oxlint's resolved config for override ownership, then lint isolated
// fixtures in the gitignored <ROOT>/scratch/oxlint-scoping-* tree with a
// generated config copy. Oxlint resolves override globs from the project root,
// so an OS temp dir does not work. Fixtures are cleaned in finally, afterAll,
// and the startup sweep.

const ROOT = join(import.meta.dir, "..", "..");
// `oxlint --print-config` normally completes in milliseconds, but it can be
// delayed by concurrent test processes on a two-core CI host.
const OXLINT_SPAWN_TIMEOUT_MS = process.platform === "win32" ? 8_000 : 5_000;
// Two config attempts take at most 16 s on Windows or 10 s elsewhere,
// leaving at least four seconds of slack in the existing hook.
const CONFIG_READ_HOOK_TIMEOUT_MS = 20_000;
// Six fixture spawns plus 2 s overhead: 50 s on Windows, 32 s elsewhere.
const FIXTURE_TEST_TIMEOUT_MS = 6 * OXLINT_SPAWN_TIMEOUT_MS + 2_000;
// One fixture spawn plus 2 s overhead: 10 s on Windows, 7 s elsewhere.
const SINGLE_FIXTURE_TEST_TIMEOUT_MS = OXLINT_SPAWN_TIMEOUT_MS + 2_000;

interface OxlintSpawnResult {
  exitCode: number | null;
  signalCode?: string;
  stdout: Buffer;
  stderr: Buffer;
}

interface OxlintResult extends OxlintSpawnResult {
  elapsedMs: number;
}

function spawnDiagnostics(result: OxlintSpawnResult, elapsedMs: number): string {
  return `exit ${result.exitCode}, signal ${result.signalCode ?? "none"}, elapsed ${elapsedMs}ms, stdout ${result.stdout.length} bytes, stderr ${result.stderr.length} bytes`;
}

function outputTails(result: OxlintSpawnResult): string {
  return `stdout (tail): ${result.stdout.toString().slice(-2_000)}\nstderr (tail): ${result.stderr.toString().slice(-2_000)}`;
}

function runOxlint(
  args: string[],
  retryTimeout = false,
  spawn: (args: string[], cwd: string) => OxlintSpawnResult = (args, cwd) =>
    Bun.spawnSync({
      cmd: [join(ROOT, "node_modules", ".bin", "oxlint"), ...args],
      cwd,
      timeout: OXLINT_SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }),
  clock: Pick<Timer, "now"> = { now: () => performance.now() },
  cwd = ROOT,
): OxlintResult {
  const attempts = retryTimeout ? 2 : 1;
  for (let attempt = 1; ; attempt++) {
    const startedAt = clock.now();
    const result = spawn(args, cwd);
    const elapsedMs = clock.now() - startedAt;
    // Bun 1.3.14 returns a null exit code and the configured kill signal when
    // spawnSync's timeout expires; ordinary non-zero exits must never retry.
    if (result.exitCode === null && result.signalCode === "SIGKILL") {
      if (attempt < attempts) {
        continue;
      }
      throw new Error(
        `oxlint ${args.join(" ")} timed out after ${OXLINT_SPAWN_TIMEOUT_MS}ms (attempt ${attempt}/${attempts}), ${spawnDiagnostics(result, elapsedMs)}\n${outputTails(result)}`,
      );
    }
    if (result.exitCode === null || ![0, 1].includes(result.exitCode)) {
      throw new Error(
        `oxlint ${args.join(" ")} failed: ${spawnDiagnostics(result, elapsedMs)}\n${outputTails(result)}`,
      );
    }
    return { ...result, elapsedMs };
  }
}

interface ResolvedOverride {
  files: string[];
  rules?: Record<string, unknown>;
}
interface ResolvedConfig {
  overrides: ResolvedOverride[];
}

let config: ResolvedConfig;
const temporaryDirectories = new Set<string>();

interface SweepFileSystem {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; isDirectory(): boolean }>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

async function sweepStaleOxlintScopingDirectories(
  directories: Array<{ path: string; maxAgeMs: number | null }>,
  filesystem: SweepFileSystem,
  now: number,
): Promise<void> {
  for (const { path: directory, maxAgeMs } of directories) {
    let entries: string[];
    try {
      entries = await filesystem.readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("oxlint-scoping-")) {
        continue;
      }
      const path = join(directory, entry);
      try {
        const info = await filesystem.stat(path);
        if (info.isDirectory() && (maxAgeMs === null || now - info.mtimeMs > maxAgeMs)) {
          await filesystem.rm(path, { recursive: true, force: true });
        }
      } catch {
        // A concurrent run may have removed the stale directory already.
      }
    }
  }
}

const realSweepFileSystem: SweepFileSystem = { readdir, stat, rm };
let fixtureConfig: Record<string, unknown>;

beforeAll(async () => {
  await sweepStaleOxlintScopingDirectories(
    [
      { path: join(ROOT, "scratch"), maxAgeMs: 60 * 60 * 1_000 },
      { path: join(ROOT, "src"), maxAgeMs: null },
      { path: join(ROOT, "test"), maxAgeMs: null },
      { path: join(ROOT, "test", "stress"), maxAgeMs: null },
      { path: tmpdir(), maxAgeMs: 60 * 60 * 1_000 },
    ],
    realSweepFileSystem,
    Date.now(),
  );
  const baseConfig = Bun.JSONC.parse(await Bun.file(join(ROOT, ".oxlintrc.json")).text()) as {
    jsPlugins: string[];
    ignorePatterns: string[];
    [key: string]: unknown;
  };
  baseConfig.jsPlugins = [join(ROOT, "oxlint-plugins", "auto-mobile.mjs")];
  baseConfig.ignorePatterns = baseConfig.ignorePatterns.filter(
    (pattern) => pattern !== "scratch/**",
  );
  fixtureConfig = baseConfig;
  const result = runOxlint(["--print-config"], true);
  if (result.exitCode !== 0) {
    throw new Error(
      `oxlint --print-config failed: ${spawnDiagnostics(result, result.elapsedMs)}\n${outputTails(result)}`,
    );
  }
  config = JSON.parse(result.stdout.toString()) as ResolvedConfig;
}, CONFIG_READ_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

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

function lintFixture(path: string, cwd: string) {
  return runOxlint(
    ["--config", join(cwd, ".oxlintrc.json"), `./${path}`],
    false,
    undefined,
    undefined,
    cwd,
  );
}

async function makeScratchDirectory(): Promise<string> {
  const scratchRoot = join(ROOT, "scratch");
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "oxlint-scoping-"));
  temporaryDirectories.add(directory);
  return directory;
}

describe(".oxlintrc.json rule scoping (via oxlint --print-config)", () => {
  test("catch-convention and no-unknown-cast are scoped to src/**", () => {
    for (const rule of ["auto-mobile/catch-convention", "auto-mobile/no-unknown-cast"]) {
      expectScopedRule(rule, ["src/**/*.ts"], "warn");
    }
  });

  test("max-params and max-lines-per-function are scoped to src/**", () => {
    for (const rule of ["max-params", "max-lines-per-function"]) {
      const override = scopedRuleOverride(rule);
      expect(override?.files).toEqual(["src/**/*.ts"]);
      expect(Array.isArray(override?.rules?.[rule])).toBe(true);
      expect((override?.rules?.[rule] as unknown[])[0]).toBe("warn");
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

  test(
    "configured globs apply to linted src, test, and stress fixtures",
    async () => {
      const scratchDirectory = await makeScratchDirectory();
      const sourceDirectory = join(scratchDirectory, "src");
      const testDirectory = join(scratchDirectory, "test");
      const stressDirectory = join(testDirectory, "stress");
      await Promise.all([mkdir(sourceDirectory), mkdir(stressDirectory, { recursive: true })]);
      await writeFile(join(scratchDirectory, ".oxlintrc.json"), JSON.stringify(fixtureConfig));
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

        const sourceAccumulatorResult = lintFixture(
          relative(scratchDirectory, sourceAccumulator),
          scratchDirectory,
        );
        expect(sourceAccumulatorResult.exitCode).toBe(1);
        expect(sourceAccumulatorResult.stdout.toString()).toContain(
          "auto-mobile(no-accumulator-foreach)",
        );

        const testAccumulatorResult = lintFixture(
          relative(scratchDirectory, testAccumulator),
          scratchDirectory,
        );
        expect(testAccumulatorResult.exitCode).toBe(0);

        const sourceBareExpectResult = lintFixture(
          relative(scratchDirectory, sourceBareExpect),
          scratchDirectory,
        );
        expect(sourceBareExpectResult.exitCode).toBe(0);

        const testBareExpectResult = lintFixture(
          relative(scratchDirectory, testBareExpect),
          scratchDirectory,
        );
        expect(testBareExpectResult.exitCode).toBe(1);
        expect(testBareExpectResult.stdout.toString()).toContain("auto-mobile(no-bare-expect)");

        const regularTimeoutResult = lintFixture(
          relative(scratchDirectory, regularTimeout),
          scratchDirectory,
        );
        expect(regularTimeoutResult.exitCode).toBe(0);

        const stressTimeoutResult = lintFixture(
          relative(scratchDirectory, stressTimeout),
          scratchDirectory,
        );
        expect(stressTimeoutResult.exitCode).toBe(1);
        expect(stressTimeoutResult.stdout.toString()).toContain(
          "auto-mobile(stress-explicit-timeout)",
        );
      } finally {
        await rm(scratchDirectory, { recursive: true, force: true });
        temporaryDirectories.delete(scratchDirectory);
      }
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  test("the raw-timer guard applies globally, with SystemTimer.ts exempted", () => {
    // `--print-config` omits top-level JavaScript-plugin rules, so run oxlint
    // against a temporary source file to prove the global rule is active.
    expectScopedRule("auto-mobile/no-raw-timer", ["**/SystemTimer.ts"], "allow");
  });

  test(
    "the raw-timer guard is active outside its SystemTimer.ts exemption",
    async () => {
      const temporaryDirectory = await makeScratchDirectory();
      const sourcePath = join(temporaryDirectory, "raw-timer.ts");
      try {
        await writeFile(join(temporaryDirectory, ".oxlintrc.json"), JSON.stringify(fixtureConfig));
        await writeFile(sourcePath, "setTimeout(() => {}, 1);\n");
        const result = lintFixture("raw-timer.ts", temporaryDirectory);
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toContain("auto-mobile(no-raw-timer)");
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
        temporaryDirectories.delete(temporaryDirectory);
      }
    },
    SINGLE_FIXTURE_TEST_TIMEOUT_MS,
  );
});

describe("bounded oxlint spawn results", () => {
  const timeoutResult: OxlintSpawnResult = {
    exitCode: null,
    signalCode: "SIGKILL",
    stdout: Buffer.from("config output"),
    stderr: Buffer.from("spawn diagnostic"),
  };
  const successResult: OxlintSpawnResult = {
    exitCode: 0,
    stdout: Buffer.from("{}"),
    stderr: Buffer.alloc(0),
  };

  test("one timeout retries once and can succeed within the hook budget", () => {
    let attempts = 0;
    const clock = new FakeTimer();
    expect(
      runOxlint(
        ["--print-config"],
        true,
        () => {
          attempts++;
          clock.advanceTime(attempts === 1 ? 10 : 7);
          return attempts === 1 ? timeoutResult : successResult;
        },
        clock,
      ),
    ).toEqual({ ...successResult, elapsedMs: 7 });
    expect(attempts).toBe(2);
    expect(2 * OXLINT_SPAWN_TIMEOUT_MS + 4_000).toBeLessThanOrEqual(CONFIG_READ_HOOK_TIMEOUT_MS);
  });

  test("a repeated timeout reports its budget and both output tails", () => {
    let attempts = 0;
    const clock = new FakeTimer();
    const spawn = () => {
      attempts++;
      clock.advanceTime(attempts === 1 ? 10 : 25);
      return timeoutResult;
    };
    expect(() => runOxlint(["--print-config"], true, spawn, clock)).toThrow(
      `timed out after ${OXLINT_SPAWN_TIMEOUT_MS}ms (attempt 2/2), exit null, signal SIGKILL, elapsed 25ms, stdout 13 bytes, stderr 16 bytes\nstdout (tail): config output\nstderr (tail): spawn diagnostic`,
    );
    expect(attempts).toBe(2);
  });

  test("fixture timeout fails after one attempt, including empty diagnostics", () => {
    let attempts = 0;
    const clock = new FakeTimer();
    expect(() =>
      runOxlint(
        ["fixture.ts"],
        false,
        () => {
          attempts++;
          clock.advanceTime(9);
          return { ...timeoutResult, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
        clock,
      ),
    ).toThrow(
      `timed out after ${OXLINT_SPAWN_TIMEOUT_MS}ms (attempt 1/1), exit null, signal SIGKILL, elapsed 9ms, stdout 0 bytes, stderr 0 bytes\nstdout (tail): \nstderr (tail): `,
    );
    expect(attempts).toBe(1);
  });

  test("non-zero exits never retry and output tails are bounded", () => {
    let attempts = 0;
    const result = { ...successResult, exitCode: 1, stdout: Buffer.from("x".repeat(2_500)) };
    expect(
      runOxlint(
        ["--print-config"],
        true,
        () => {
          attempts++;
          return result;
        },
        new FakeTimer(),
      ),
    ).toEqual({ ...result, elapsedMs: 0 });
    expect(attempts).toBe(1);
    expect(spawnDiagnostics(result, 0)).toBe(
      "exit 1, signal none, elapsed 0ms, stdout 2500 bytes, stderr 0 bytes",
    );
    expect(outputTails(result)).toBe(`stdout (tail): ${"x".repeat(2_000)}\nstderr (tail): `);
  });

  test("unexpected exit codes report diagnostics without retrying", () => {
    let attempts = 0;
    const clock = new FakeTimer();
    expect(() =>
      runOxlint(
        ["--print-config"],
        true,
        () => {
          attempts++;
          clock.advanceTime(17);
          return {
            exitCode: 3,
            stdout: Buffer.from("é"),
            stderr: Buffer.from("bad exit"),
          };
        },
        clock,
      ),
    ).toThrow(
      "failed: exit 3, signal none, elapsed 17ms, stdout 2 bytes, stderr 8 bytes\nstdout (tail): é\nstderr (tail): bad exit",
    );
    expect(attempts).toBe(1);
  });

  test("other signals fail clearly without retrying", () => {
    let attempts = 0;
    const clock = new FakeTimer();
    expect(() =>
      runOxlint(
        ["--print-config"],
        true,
        () => {
          attempts++;
          clock.advanceTime(42);
          return { ...timeoutResult, signalCode: "SIGTERM" };
        },
        clock,
      ),
    ).toThrow(
      "failed: exit null, signal SIGTERM, elapsed 42ms, stdout 13 bytes, stderr 16 bytes\nstdout (tail): config output\nstderr (tail): spawn diagnostic",
    );
    expect(attempts).toBe(1);
  });
});

describe("oxlint fixture scratch cleanup", () => {
  test("removes stale matching directories while preserving fresh and unrelated entries", async () => {
    const now = 10_000_000;
    const directories = [
      { path: "/repo/src", maxAgeMs: null },
      { path: "/repo/scratch", maxAgeMs: 60 * 60 * 1_000 },
      { path: tmpdir(), maxAgeMs: 60 * 60 * 1_000 },
    ];
    const entries: Record<string, string[]> = {
      "/repo/src": ["oxlint-scoping-legacy", "keep-me"],
      "/repo/scratch": ["oxlint-scoping-stale", "oxlint-scoping-fresh", "other"],
      [tmpdir()]: ["oxlint-scoping-stale", "oxlint-scoping-fresh", "other"],
    };
    const mtimes: Record<string, number> = {
      [join("/repo/src", "oxlint-scoping-legacy")]: now - 24 * 60 * 60 * 1_000,
      [join("/repo/scratch", "oxlint-scoping-stale")]: now - 60 * 60 * 1_000 - 1,
      [join("/repo/scratch", "oxlint-scoping-fresh")]: now - 1,
      [join(tmpdir(), "oxlint-scoping-stale")]: now - 60 * 60 * 1_000 - 1,
      [join(tmpdir(), "oxlint-scoping-fresh")]: now - 1,
    };
    const removed: string[] = [];
    await sweepStaleOxlintScopingDirectories(
      directories,
      {
        readdir: async (directory) => entries[directory] ?? [],
        stat: async (path) => ({ mtimeMs: mtimes[path] ?? now, isDirectory: () => true }),
        rm: async (path) => {
          removed.push(path);
        },
      },
      now,
    );
    expect(removed).toEqual([
      join("/repo/src", "oxlint-scoping-legacy"),
      join("/repo/scratch", "oxlint-scoping-stale"),
      join(tmpdir(), "oxlint-scoping-stale"),
    ]);
  });
});
