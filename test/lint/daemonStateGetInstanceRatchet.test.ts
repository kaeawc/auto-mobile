import { typeScriptFiles, relativePosix } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { countDaemonStateGetInstanceCalls } from "./daemonStateGetInstanceCalls";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const BASELINE_FILE = path.join(import.meta.dir, "daemon-state-get-instance-baseline.txt");
// Parsing every src file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;
const UPDATE_COMMAND =
  "UPDATE_DAEMON_STATE_BASELINE=1 bun test test/lint/daemonStateGetInstanceRatchet.test.ts";

type Counts = Record<string, number>;

function readBaseline(): Counts {
  const counts: Counts = {};
  for (const line of readFileSync(BASELINE_FILE, "utf8").split(/\r?\n/).filter(Boolean)) {
    const [file, count] = line.split("\t");
    counts[file] = Number(count);
  }
  return counts;
}

function formatBaseline(counts: Counts): string {
  return Object.keys(counts)
    .sort()
    .map((file) => `${file}\t${counts[file]}\n`)
    .join("");
}

describe("countDaemonStateGetInstanceCalls", () => {
  test.each([
    "DaemonState.getInstance();",
    "DaemonState?.getInstance();",
    'DaemonState["getInstance"]();',
    "(DaemonState.getInstance)();",
    "DaemonState.getInstance().getSessionManager();",
    "DaemonState.getInstance!();",
  ])("counts a call: %s", (source) => {
    expect(countDaemonStateGetInstanceCalls("fixture.ts", source)).toBe(1);
  });

  test.each([
    "type T = ReturnType<typeof DaemonState.getInstance>;",
    "// DaemonState.getInstance()",
    'const s = "DaemonState.getInstance()";',
    "Other.getInstance();",
    "DaemonState.resetInstance();",
    "const f = DaemonState.getInstance;",
  ])("ignores a non-call: %s", (source) => {
    expect(countDaemonStateGetInstanceCalls("fixture.ts", source)).toBe(0);
  });

  test("counts every call in a file", () => {
    expect(
      countDaemonStateGetInstanceCalls(
        "fixture.ts",
        "DaemonState.getInstance();\nfoo(DaemonState.getInstance());",
      ),
    ).toBe(2);
  });

  test("reports syntax errors with the file name", () => {
    expect(() => countDaemonStateGetInstanceCalls("broken.ts", "DaemonState.getInstance(")).toThrow(
      "broken.ts:",
    );
  });
});

describe("DaemonState.getInstance() call sites in src/ never grow (#11806)", () => {
  const found: Counts = {};
  let baseline: Counts = {};

  beforeAll(() => {
    for (const file of typeScriptFiles(SRC_DIR)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("DaemonState")) {
        continue;
      }
      const count = countDaemonStateGetInstanceCalls(file, source);
      if (count > 0) {
        found[relativePosix(REPO_ROOT, file)] = count;
      }
    }
    const update = process.env.UPDATE_DAEMON_STATE_BASELINE;
    if (update) {
      baseline = readBaseline();
      const grew = Object.keys(found).filter((file) => found[file] > (baseline[file] ?? 0));
      if (update !== "grow" && grew.length > 0) {
        throw new Error(`Refusing to grow the baseline for: ${grew.join(", ")}`);
      }
      writeFileSync(BASELINE_FILE, formatBaseline(found));
    }
    baseline = readBaseline();
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no file has more DaemonState.getInstance() calls than its baseline", () => {
    const grown = Object.keys(found)
      .filter((file) => found[file] > (baseline[file] ?? 0))
      .map((file) => `${file}: ${baseline[file] ?? 0} -> ${found[file]}`);
    expect(
      grown,
      "Pass the daemon state (or the narrow service you need) in as a dependency instead of reaching for DaemonState.getInstance().",
    ).toEqual([]);
  });

  test("the baseline records every shrink, so it can only go down", () => {
    const stale = Object.keys(baseline)
      .filter((file) => (found[file] ?? 0) < baseline[file])
      .map((file) => `${file}: ${baseline[file]} -> ${found[file] ?? 0}`);
    expect(stale, `Run: ${UPDATE_COMMAND}  and commit the smaller baseline.`).toEqual([]);
  });

  test("the baseline file is sorted by path", () => {
    const files = Object.keys(baseline);
    expect(files).toEqual([...files].sort());
  });
});
