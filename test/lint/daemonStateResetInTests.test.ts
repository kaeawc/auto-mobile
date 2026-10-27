import { beforeAll, describe, expect, test } from "bun:test";

import { join, relative, sep } from "node:path";
import { type Expression } from "oxc-parser";
import {
  parseGuardSource,
  unwrapCallee,
  guardDirectoryEntries,
  readGuardFile,
  GuardVisitor as Visitor,
} from "./astGuard";

/**
 * Leak guard for the process-wide `DaemonState` singleton (issue #11614).
 *
 * `new Daemon(...)` and `DaemonState.getInstance().initialize(...)` publish a session manager and
 * device pool on the singleton. `bun test` runs shared-process files in ONE process, so a file
 * that never resets it leaves every later file reading its fakes: `observationRequestHeldElsewhere`
 * left a fake-laden manager behind and `TapOnElement.toolDispatch` then failed with
 * "undefined is not an object (evaluating ... cacheData ...)" only when the seed ordered it after.
 * "Initialized here, reset in this file" is an ordering obligation no type can express, so it is an
 * AST scan over test files (strings and comments that merely mention the calls do not count).
 */
const ROOT = join(import.meta.dir, "..", "..");
const TEST = join(ROOT, "test");

function isDaemonStateInstance(expression: Expression): boolean {
  const call = unwrapCallee(expression);
  const callee = call.type === "CallExpression" ? unwrapCallee(call.callee) : undefined;
  return (
    callee?.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "DaemonState" &&
    !callee.computed &&
    callee.property.name === "getInstance"
  );
}

/** Whether a file publishes onto the singleton (`new Daemon(` or `.initialize(`) or resets it. */
export function daemonStateUsage(
  file: string,
  source: string,
): { initializes: boolean; resets: boolean } {
  const usage = { initializes: false, resets: false };
  // Cheap prefilter: only files that mention the singleton or the Daemon class are parsed.
  if (!/Daemon/.test(source)) {
    return usage;
  }
  new Visitor({
    NewExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (callee.type === "Identifier" && callee.name === "Daemon") {
        usage.initializes = true;
      }
    },
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        isDaemonStateInstance(callee.object)
      ) {
        if (callee.property.name === "initialize") {
          usage.initializes = true;
        } else if (callee.property.name === "reset") {
          usage.resets = true;
        }
      }
    },
  }).visit(parseGuardSource(file, source));
  return usage;
}

function testFiles(dir: string): string[] {
  return guardDirectoryEntries(dir).flatMap((entry) => {
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

  // Parsing is captured once, outside the per-test budget; each bucket test asserts its slice.
  let offendersByBucket: string[][];
  beforeAll(() => {
    offendersByBucket = buckets.map((bucket) =>
      bucket
        .filter((file) => {
          const usage = daemonStateUsage(file, readGuardFile(file));
          return usage.initializes && !usage.resets;
        })
        .map((file) => relative(ROOT, file).split(sep).join("/")),
    );
  }, 30_000);

  test.each(buckets.map((_, index) => ({ index })))(
    "every unit test file that publishes onto DaemonState also resets it (bucket $index)",
    ({ index }) => {
      expect(offendersByBucket[index]).toEqual([]);
    },
  );

  test("the scan recognises the initializing and resetting spellings", () => {
    const usage = (source: string) => daemonStateUsage("fixture.test.ts", source);
    expect(usage("const d = new Daemon({}, undefined);")).toEqual({
      initializes: true,
      resets: false,
    });
    expect(usage("DaemonState.getInstance().initialize(sm, pool);").initializes).toBe(true);
    expect(usage("afterEach(() => DaemonState.getInstance().reset());").resets).toBe(true);
    expect(usage("manager.reset();").resets).toBe(false);
  });

  test("a violating file is flagged: initialized but only mentions the reset", () => {
    const violating = daemonStateUsage(
      "fixture.test.ts",
      `new Daemon({});
      // DaemonState.getInstance().reset()
      const note = "DaemonState.getInstance().reset()";`,
    );
    expect(violating.initializes && !violating.resets).toBe(true);
    const compliant = daemonStateUsage(
      "fixture.test.ts",
      "DaemonState.getInstance().initialize(a, b); afterEach(() => { DaemonState.getInstance().reset(); });",
    );
    expect(compliant.initializes && !compliant.resets).toBe(false);
  });
});
