import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Leak guard for the process-wide `DaemonState` singleton (issue #11614).
 *
 * `new Daemon(...)` and `DaemonState.getInstance().initialize(...)` publish a session manager and
 * device pool on the singleton. `bun test` runs shared-process files in ONE process, so a file
 * that never resets it leaves every later file reading its fakes: `observationRequestHeldElsewhere`
 * left a fake-laden manager behind and `TapOnElement.toolDispatch` then failed with
 * "undefined is not an object (evaluating ... cacheData ...)" only when the seed ordered it after.
 * "Initialized here, reset in this file" is an ordering obligation no type can express, so it is a
 * source scan over test files.
 */
const ROOT = join(import.meta.dir, "..", "..");
const TEST = join(ROOT, "test");
const INITIALIZES = /new Daemon\(|DaemonState\.getInstance\(\)\.initialize\(/;
const RESETS = /DaemonState\.getInstance\(\)\.reset\(\)/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return testFiles(path);
    }
    return entry.name.endsWith(".test.ts") && !entry.name.endsWith(".integration.test.ts")
      ? [path]
      : [];
  });
}

const files = testFiles(TEST).sort();
// Eight buckets peaked at 12.53 ms locally; use sixteen for headroom below 12 ms.
// Raise the count as the tree grows, keeping each content-read test within that budget.
const BUCKET_COUNT = 16;
const buckets = Array.from({ length: BUCKET_COUNT }, (_, index) =>
  files.slice(
    Math.floor((index * files.length) / BUCKET_COUNT),
    Math.floor(((index + 1) * files.length) / BUCKET_COUNT),
  ),
);

describe("test files that initialize DaemonState reset it (issue #11614)", () => {
  test("the buckets cover the complete, non-trivial unit test listing exactly once", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files.map((file) => relative(ROOT, file).split(sep).join("/"))).toContain(
      "test/lint/daemonStateResetInTests.test.ts",
    );
    expect(buckets.flat()).toEqual(files);
    expect(new Set(buckets.flat()).size).toBe(files.length);
  });

  test.each(buckets.map((bucket, index) => ({ bucket, index })))(
    "every unit test file that publishes onto DaemonState also resets it (bucket $index)",
    ({ bucket }) => {
      const offenders = bucket
        .filter((file) => {
          const source = readFileSync(file, "utf8");
          return INITIALIZES.test(source) && !RESETS.test(source);
        })
        .map((file) => relative(ROOT, file).split(sep).join("/"));
      expect(offenders).toEqual([]);
    },
  );

  test("the scan recognises the initializing and resetting spellings", () => {
    expect(INITIALIZES.test("const d = new Daemon({}, undefined);")).toBe(true);
    expect(INITIALIZES.test("DaemonState.getInstance().initialize(sm, pool);")).toBe(true);
    expect(RESETS.test("afterEach(() => DaemonState.getInstance().reset());")).toBe(true);
    expect(RESETS.test("manager.reset();")).toBe(false);
  });
});
