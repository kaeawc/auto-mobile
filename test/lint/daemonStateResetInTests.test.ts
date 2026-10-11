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

describe("test files that initialize DaemonState reset it (issue #11614)", () => {
  test("every unit test file that publishes onto DaemonState also resets it", () => {
    const offenders = testFiles(TEST)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return INITIALIZES.test(source) && !RESETS.test(source);
      })
      .map((file) => relative(ROOT, file).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });

  test("the scan recognises the initializing and resetting spellings", () => {
    expect(INITIALIZES.test("const d = new Daemon({}, undefined);")).toBe(true);
    expect(INITIALIZES.test("DaemonState.getInstance().initialize(sm, pool);")).toBe(true);
    expect(RESETS.test("afterEach(() => DaemonState.getInstance().reset());")).toBe(true);
    expect(RESETS.test("manager.reset();")).toBe(false);
  });
});
