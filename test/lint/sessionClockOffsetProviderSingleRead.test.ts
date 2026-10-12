import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync, Visitor } from "oxc-parser";

// #11576: `ExecutionTracker` adds the session-clock offset to the wall reading it took for an
// execution's start, and passes that reading to the provider. A test that runs the session clock
// on a FakeTimer under the wall-clock tracker and reads the wall clock again
// (`() => sessionNow() - Date.now()`) can land on the next millisecond, dating the call 1 ms early:
// on Windows CI a tap sent 1 ms after an idle deadline was admitted. A test's provider must
// subtract the reading it is given; only the parameter's default may read a clock (no reading is
// passed for a deadline). TypeScript accepts a provider that ignores its parameter, so this is a
// source scan. The daemon's own provider is exempt: its session clock is not millisecond-aligned
// with the wall clock to begin with.
const ROOT = path.join(import.meta.dir, "..", "..");
const SCANNED_DIRS = ["test"];
const SETTER = "setSessionClockOffsetProvider";
// Reading every source file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;
const SELF = "test/lint/sessionClockOffsetProviderSingleRead.test.ts";

function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : typeScriptFiles(file);
    }
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

/** 1-based lines of offset providers that read a clock (`<anything>.now()`) themselves. */
export function findClockReadingOffsetProviders(source: string): string[] {
  if (!source.includes(SETTER)) {
    return [];
  }
  const parsed = parseSync("offsetProvider.ts", source);
  if (parsed.errors.length > 0) {
    return parsed.errors.map((error) => `parse error: ${error.message}`);
  }
  const found = new Set<string>();
  const lineOf = (offset: number) => `${source.slice(0, offset).split("\n").length}`;
  new Visitor({
    CallExpression(node) {
      const callee = node.callee;
      if (
        callee.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.type !== "Identifier" ||
        callee.property.name !== SETTER
      ) {
        return;
      }
      const provider = node.arguments[0];
      if (provider?.type !== "ArrowFunctionExpression" && provider?.type !== "FunctionExpression") {
        // A provider passed by name is not followed; none exists, and inline is the convention.
        if (provider) {
          found.add(`${lineOf(node.start)}: provider must be an inline function`);
        }
        return;
      }
      // A parameter default may read the wall clock: it runs only when the tracker passed no
      // reading (a deadline). The body must use the parameter.
      const inParameters = (offset: number) =>
        provider.params.some((param) => param.start <= offset && offset < param.end);
      new Visitor({
        CallExpression(inner) {
          const innerCallee = inner.callee;
          if (
            innerCallee.type === "MemberExpression" &&
            !innerCallee.computed &&
            innerCallee.property.type === "Identifier" &&
            innerCallee.property.name === "now" &&
            !inParameters(inner.start)
          ) {
            found.add(lineOf(inner.start));
          }
        },
      }).visit(provider);
    },
  }).visit(parsed.program);
  return [...found];
}

describe("session-clock offset providers never read a clock twice (#11576)", () => {
  test.each([
    "tracker.setSessionClockOffsetProvider(() => manager.sessionNow() - Date.now());",
    "tracker.setSessionClockOffsetProvider(() => this.sessionManager.sessionNow() - this.timer.now());",
    "tracker.setSessionClockOffsetProvider(function () { return m.sessionNow() - performance.now(); });",
    "tracker.setSessionClockOffsetProvider(() => Date.now());",
    "tracker.setSessionClockOffsetProvider((wallNowMs = Date.now()) => m.sessionNow() - timer.now());",
  ])("flags a provider that reads the wall clock itself: %s", (source) => {
    expect(findClockReadingOffsetProviders(source)).toEqual(["1"]);
  });

  test("accepts providers that convert the tracker's reading, and constants", () => {
    expect(
      findClockReadingOffsetProviders(`
        tracker.setSessionClockOffsetProvider((wallNowMs) => manager.sessionNow() - wallNowMs);
        tracker.setSessionClockOffsetProvider(
          (wallNowMs = this.timer.now()) => manager.sessionNow() - wallNowMs,
        );
        tracker.setSessionClockOffsetProvider(() => 0);
        const unrelated = () => Date.now();
      `),
    ).toEqual([]);
  });

  test("a provider passed by name is reported, since it is not followed", () => {
    expect(
      findClockReadingOffsetProviders("tracker.setSessionClockOffsetProvider(offset);"),
    ).toEqual(["1: provider must be an inline function"]);
  });

  test("reports syntax errors instead of skipping the file", () => {
    expect(findClockReadingOffsetProviders(`x.${SETTER}((`)[0]).toStartWith("parse error:");
  });

  let offenders: string[];
  let callSites: number;
  beforeAll(() => {
    callSites = 0;
    offenders = SCANNED_DIRS.flatMap((dir) => typeScriptFiles(path.join(ROOT, dir))).flatMap(
      (file) => {
        const relative = path.relative(ROOT, file).split(path.sep).join("/");
        if (relative === SELF) {
          return [];
        }
        const source = readFileSync(file, "utf8");
        callSites += source.split(`.${SETTER}(`).length - 1;
        return findClockReadingOffsetProviders(source).map((line) => `${relative}:${line}`);
      },
    );
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no provider in test/ reads a clock in its body", () => {
    // The suites that wire a tracker to a session clock; zero means the scan broke.
    expect(callSites).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
  });
});
