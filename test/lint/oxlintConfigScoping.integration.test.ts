import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

// The custom rules' file-scoping used to be enforced (and tested) through
// eslint.config.mjs's `files:` globs. Under oxlint that scoping lives in
// .oxlintrc.json's `overrides`, so the "does not apply outside <glob>"
// guarantees that bareExpectRule / accumulatorForEachRule / stressExplicitTimeout
// used to assert are now asserted here.
//
// Override ownership is read from .oxlintrc.json itself, normalized the way
// `oxlint --print-config` prints it. Spawning `--print-config` hung on Windows
// runners with no output on both attempts while a control `bun --version`
// launch took 9-14 ms (#16415, #16983), so the config read no longer spawns.
// That oxlint really applies the globs is proven end to end by linting isolated
// fixtures in the gitignored <ROOT>/scratch/oxlint-scoping-* tree with a
// generated config copy, in ONE oxlint invocation over every fixture. Oxlint
// resolves override globs from the project root, so an OS temp dir does not
// work. Fixtures are cleaned in afterAll and the startup sweep.

const ROOT = join(import.meta.dir, "..", "..");
// A fixture lint normally takes well under a second, but it can be delayed by
// concurrent test processes on a two-core CI host.
const OXLINT_SPAWN_TIMEOUT_MS = process.platform === "win32" ? 8_000 : 5_000;
// After a timeout, one trivial `bun --version` launch is timed so the failure
// shows whether the runner itself is starved or only oxlint stalled (#16415).
const CONTROL_SPAWN_TIMEOUT_MS = 2_000;
// Two lint attempts plus the control spawn take at most 18 s on Windows or
// 12 s elsewhere, leaving at least two seconds of slack in the hook.
const FIXTURE_LINT_HOOK_TIMEOUT_MS = 20_000;

interface OxlintSpawnResult {
  exitCode: number | null;
  signalCode?: string | number;
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
  controlSpawn: () => OxlintSpawnResult = () =>
    Bun.spawnSync({
      cmd: [process.execPath, "--version"],
      timeout: CONTROL_SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }),
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
      const controlStartedAt = clock.now();
      const control = controlSpawn();
      const controlElapsedMs = clock.now() - controlStartedAt;
      throw new Error(
        `oxlint ${args.join(" ")} timed out after ${OXLINT_SPAWN_TIMEOUT_MS}ms (attempt ${attempt}/${attempts}), ${spawnDiagnostics(result, elapsedMs)}\ncontrol spawn (bun --version): ${spawnDiagnostics(control, controlElapsedMs)}\n${outputTails(result)}`,
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
interface RawOxlintConfig {
  jsPlugins: string[];
  ignorePatterns: string[];
  overrides: ResolvedOverride[];
  [key: string]: unknown;
}

const PRINTED_SEVERITY: Record<string, string> = {
  error: "deny",
  "2": "deny",
  warn: "warn",
  "1": "warn",
  off: "allow",
  "0": "allow",
};

// Mirror `oxlint --print-config`: a rule's severity prints as deny/warn/allow,
// and a configured rule's options print as one array after the severity.
function printedRuleSetting(setting: unknown): unknown {
  const [severity, ...options] = Array.isArray(setting) ? setting : [setting];
  const printed = PRINTED_SEVERITY[String(severity)];
  if (printed === undefined) {
    throw new Error(`unknown oxlint rule severity: ${JSON.stringify(severity)}`);
  }
  return Array.isArray(setting) ? [printed, options] : printed;
}

function resolveOverrides(raw: Pick<RawOxlintConfig, "overrides">): ResolvedConfig {
  return {
    overrides: raw.overrides.map((override) => ({
      ...override,
      rules: override.rules
        ? Object.fromEntries(
            Object.entries(override.rules).map(([rule, setting]) => [
              rule,
              printedRuleSetting(setting),
            ]),
          )
        : undefined,
    })),
  };
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
let fixtureConfig: RawOxlintConfig;

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
  const baseConfig = Bun.JSONC.parse(
    await Bun.file(join(ROOT, ".oxlintrc.json")).text(),
  ) as RawOxlintConfig;
  config = resolveOverrides(baseConfig);
  fixtureConfig = {
    ...baseConfig,
    jsPlugins: [join(ROOT, "oxlint-plugins", "auto-mobile.mjs")],
    ignorePatterns: baseConfig.ignorePatterns.filter((pattern) => pattern !== "scratch/**"),
  };
});

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

interface OxlintJsonReport {
  diagnostics: Array<{ code: string; filename: string }>;
  number_of_files: number;
}

// Group `oxlint -f json` diagnostic codes by forward-slash fixture path, so the
// same assertions hold for Windows' backslash filenames.
function diagnosticCodesByFile(stdout: string): {
  lintedFiles: number;
  codes: Map<string, string[]>;
} {
  const report = JSON.parse(stdout) as OxlintJsonReport;
  const codes = new Map<string, string[]>();
  for (const { code, filename } of report.diagnostics) {
    const path = filename.replaceAll("\\", "/").replace(/^\.\//, "");
    codes.set(path, [...(codes.get(path) ?? []), code]);
  }
  return { lintedFiles: report.number_of_files, codes };
}

async function makeScratchDirectory(): Promise<string> {
  const scratchRoot = join(ROOT, "scratch");
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "oxlint-scoping-"));
  temporaryDirectories.add(directory);
  return directory;
}

const ACCUMULATOR_FIXTURE = `const output: string[] = [];
["item"].forEach((item) => {
  output.push(item);
});
`;
const BARE_EXPECT_FIXTURE = "expect(true);\n";
const MISSING_TIMEOUT_FIXTURE = `import { test } from "bun:test";
test("fixture", async () => {
  await Promise.resolve();
});
`;
const FIXTURES: Record<string, string> = {
  "src/accumulator.ts": ACCUMULATOR_FIXTURE,
  "test/accumulator.ts": ACCUMULATOR_FIXTURE,
  "src/bare-expect.ts": BARE_EXPECT_FIXTURE,
  "test/bare-expect.ts": BARE_EXPECT_FIXTURE,
  "test/timeout.test.ts": MISSING_TIMEOUT_FIXTURE,
  "test/stress/timeout.test.ts": MISSING_TIMEOUT_FIXTURE,
  "raw-timer.ts": "setTimeout(() => {}, 1);\n",
};

describe(".oxlintrc.json rule scoping (as oxlint --print-config prints it)", () => {
  test("catch-convention is scoped to src/**; casts are hard errors in src and test", () => {
    expectScopedRule("auto-mobile/catch-convention", ["src/**/*.ts"], "deny");
    // Fully burned down, so enforced directly by oxlint (printed as "deny").
    expectScopedRule("auto-mobile/no-unknown-cast", ["src/**/*.ts", "test/**/*.ts"], "deny");
  });

  test("no-as-any is a hard error scoped to test/**", () => {
    expectScopedRule("auto-mobile/no-as-any", ["test/**/*.ts"], "deny");
  });

  test("max-params and max-lines-per-function are scoped to src/**", () => {
    for (const rule of ["max-params", "max-lines-per-function"]) {
      const override = scopedRuleOverride(rule);
      expect(override?.files).toEqual(["src/**/*.ts"]);
      expect(Array.isArray(override?.rules?.[rule])).toBe(true);
      expect((override?.rules?.[rule] as unknown[])[0]).toBe("deny");
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
    // The global rule lives in top-level `rules`, so the fixture lint below
    // proves it is active outside the exemption.
    expectScopedRule("auto-mobile/no-raw-timer", ["**/SystemTimer.ts"], "allow");
  });
});

describe("oxlint applies the configured globs to linted fixtures", () => {
  let lintedFiles = 0;
  let codes = new Map<string, string[]>();
  let exitCode: number | null = null;

  beforeAll(async () => {
    const scratchDirectory = await makeScratchDirectory();
    await mkdir(join(scratchDirectory, "src"));
    await mkdir(join(scratchDirectory, "test", "stress"), { recursive: true });
    await writeFile(join(scratchDirectory, ".oxlintrc.json"), JSON.stringify(fixtureConfig));
    await Promise.all(
      Object.entries(FIXTURES).map(([path, contents]) =>
        writeFile(join(scratchDirectory, path), contents),
      ),
    );
    // One process lints every fixture, so a single retried spawn bounds the
    // whole check instead of one timeout-prone launch per case.
    const result = runOxlint(
      [
        "--config",
        join(scratchDirectory, ".oxlintrc.json"),
        "--format",
        "json",
        ...Object.keys(FIXTURES).map((path) => `./${path}`),
      ],
      true,
      undefined,
      undefined,
      scratchDirectory,
    );
    exitCode = result.exitCode;
    ({ lintedFiles, codes } = diagnosticCodesByFile(result.stdout.toString()));
  }, FIXTURE_LINT_HOOK_TIMEOUT_MS);

  test("every fixture is linted in the one invocation", () => {
    expect(lintedFiles).toBe(Object.keys(FIXTURES).length);
    expect(exitCode).toBe(1);
  });

  test("no-accumulator-foreach fires in src/** but not test/**", () => {
    expect(codes.get("src/accumulator.ts")).toContain("auto-mobile(no-accumulator-foreach)");
    expect(codes.get("test/accumulator.ts") ?? []).toEqual([]);
  });

  test("no-bare-expect fires in test/** but not src/**", () => {
    expect(codes.get("src/bare-expect.ts") ?? []).toEqual([]);
    expect(codes.get("test/bare-expect.ts")).toContain("auto-mobile(no-bare-expect)");
  });

  test("stress-explicit-timeout fires in test/stress/** but not elsewhere in test/**", () => {
    expect(codes.get("test/timeout.test.ts") ?? []).toEqual([]);
    expect(codes.get("test/stress/timeout.test.ts")).toContain(
      "auto-mobile(stress-explicit-timeout)",
    );
  });

  test("the raw-timer guard is active outside its SystemTimer.ts exemption", () => {
    expect(codes.get("raw-timer.ts")).toContain("auto-mobile(no-raw-timer)");
  });
});

describe("config normalization and fixture report parsing", () => {
  test("severities and options normalize the way oxlint --print-config prints them", () => {
    expect(
      resolveOverrides({
        overrides: [
          {
            files: ["src/**/*.ts"],
            rules: { a: "error", b: "warn", c: "off", d: 2, e: 0, f: ["error", { max: 3 }] },
          },
          { files: ["test/**/*.ts"] },
        ],
      }),
    ).toEqual({
      overrides: [
        {
          files: ["src/**/*.ts"],
          rules: {
            a: "deny",
            b: "warn",
            c: "allow",
            d: "deny",
            e: "allow",
            f: ["deny", [{ max: 3 }]],
          },
        },
        { files: ["test/**/*.ts"], rules: undefined },
      ],
    });
  });

  test("an unknown severity fails instead of silently passing", () => {
    expect(() =>
      resolveOverrides({ overrides: [{ files: ["x"], rules: { a: "fatal" } }] }),
    ).toThrow('unknown oxlint rule severity: "fatal"');
  });

  test("Windows backslash and ./-prefixed filenames group under forward-slash paths", () => {
    const { lintedFiles, codes } = diagnosticCodesByFile(
      JSON.stringify({
        diagnostics: [
          { code: "auto-mobile(no-bare-expect)", filename: "test\\bare-expect.ts" },
          { code: "auto-mobile(no-raw-timer)", filename: "./raw-timer.ts" },
          { code: "eqeqeq", filename: "test/bare-expect.ts" },
        ],
        number_of_files: 2,
      }),
    );
    expect(lintedFiles).toBe(2);
    expect(Object.fromEntries(codes)).toEqual({
      "test/bare-expect.ts": ["auto-mobile(no-bare-expect)", "eqeqeq"],
      "raw-timer.ts": ["auto-mobile(no-raw-timer)"],
    });
  });
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
    expect(2 * OXLINT_SPAWN_TIMEOUT_MS + CONTROL_SPAWN_TIMEOUT_MS + 2_000).toBeLessThanOrEqual(
      FIXTURE_LINT_HOOK_TIMEOUT_MS,
    );
  });

  test("a repeated timeout reports its budget and both output tails", () => {
    let attempts = 0;
    const clock = new FakeTimer();
    const spawn = () => {
      attempts++;
      clock.advanceTime(attempts === 1 ? 10 : 25);
      return timeoutResult;
    };
    const control = () => {
      clock.advanceTime(30);
      return successResult;
    };
    expect(() => runOxlint(["--print-config"], true, spawn, clock, undefined, control)).toThrow(
      `timed out after ${OXLINT_SPAWN_TIMEOUT_MS}ms (attempt 2/2), exit null, signal SIGKILL, elapsed 25ms, stdout 13 bytes, stderr 16 bytes\ncontrol spawn (bun --version): exit 0, signal none, elapsed 30ms, stdout 2 bytes, stderr 0 bytes\nstdout (tail): config output\nstderr (tail): spawn diagnostic`,
    );
    expect(attempts).toBe(2);
  });

  test("a timed-out control spawn is reported, so a starved runner is visible", () => {
    const clock = new FakeTimer();
    const spawn = () => {
      clock.advanceTime(8);
      return timeoutResult;
    };
    const control = () => {
      clock.advanceTime(CONTROL_SPAWN_TIMEOUT_MS);
      return { ...timeoutResult, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    expect(() => runOxlint(["fixture.ts"], false, spawn, clock, undefined, control)).toThrow(
      `control spawn (bun --version): exit null, signal SIGKILL, elapsed ${CONTROL_SPAWN_TIMEOUT_MS}ms, stdout 0 bytes, stderr 0 bytes`,
    );
  });

  test("the control spawn runs only after the last timed-out attempt", () => {
    let attempts = 0;
    let controls = 0;
    const clock = new FakeTimer();
    expect(
      runOxlint(
        ["--print-config"],
        true,
        () => {
          attempts++;
          return attempts === 1 ? timeoutResult : successResult;
        },
        clock,
        undefined,
        () => {
          controls++;
          return successResult;
        },
      ),
    ).toEqual({ ...successResult, elapsedMs: 0 });
    expect(controls).toBe(0);
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
        undefined,
        () => successResult,
      ),
    ).toThrow(
      `timed out after ${OXLINT_SPAWN_TIMEOUT_MS}ms (attempt 1/1), exit null, signal SIGKILL, elapsed 9ms, stdout 0 bytes, stderr 0 bytes\ncontrol spawn (bun --version): exit 0, signal none, elapsed 0ms, stdout 2 bytes, stderr 0 bytes\nstdout (tail): \nstderr (tail): `,
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
