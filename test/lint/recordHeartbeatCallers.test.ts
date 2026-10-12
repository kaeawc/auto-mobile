import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scanRecordHeartbeatCalls } from "./recordHeartbeatCallers";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const TEST_DIR = path.join(REPO_ROOT, "test");
const BASELINE_FILE = path.join(import.meta.dir, "record-heartbeat-callers-baseline.txt");
// Equals the baseline's line count; the UPDATE command below keeps it in sync.
const BASELINE_CEILING = 35;
// Parsing every test file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;
const HARNESS_FILE = "test/helpers/livenessScenarioHarness.ts";

function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : typeScriptFiles(file);
    }
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

function relativePosix(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

describe("scanRecordHeartbeatCalls", () => {
  test.each([
    "manager.recordHeartbeat(sessionId);",
    "manager?.recordHeartbeat(sessionId);",
    'manager["recordHeartbeat"](sessionId);',
    "recordHeartbeat(sessionId);",
    "manager.recordHeartbeat?.(sessionId);",
    'manager?.["recordHeartbeat"](sessionId);',
    'manager["record\\u0048eartbeat"](sessionId);',
  ])("flags a direct call: %s", (source) => {
    expect(scanRecordHeartbeatCalls("fixture.ts", source)).toEqual([{ line: 1 }]);
  });

  test("reports both calls on their correct lines", () => {
    expect(
      scanRecordHeartbeatCalls(
        "fixture.ts",
        "\nmanager.recordHeartbeat(id);\n\nrecordHeartbeat(id);",
      ),
    ).toEqual([{ line: 2 }, { line: 4 }]);
  });

  test("ignores definitions, spies, mentions and longer names", () => {
    const source = `
      class Fake { recordHeartbeat(id: string) {} }
      const fake = { recordHeartbeat(id: string) {} };
      interface Manager { recordHeartbeat(id: string): void; }
      spyOn(manager, "recordHeartbeat");
      const mention = "manager.recordHeartbeat(id)";
      // manager.recordHeartbeat(id);
      const template = \`manager.recordHeartbeat(id)\`;
      recordHeartbeatAt(id);
      manager.recordHeartbeatAt(id);
      manager[recordHeartbeat](id);
    `;
    expect(scanRecordHeartbeatCalls("fixture.ts", source)).toEqual([]);
  });

  test("reports syntax errors with the file name", () => {
    expect(() => scanRecordHeartbeatCalls("broken.ts", "manager.recordHeartbeat(")).toThrow(
      "broken.ts:",
    );
    expect(() => scanRecordHeartbeatCalls("broken.ts", "const =")).toThrow("broken.ts:");
  });
});

const UPDATE_COMMAND =
  "UPDATE_RECORD_HEARTBEAT_BASELINE=1 bun test test/lint/recordHeartbeatCallers.test.ts";

describe("direct recordHeartbeat callers stay within the baseline", () => {
  let baseline: readonly string[] = [];
  let found: readonly string[] = [];
  let callSites: readonly { file: string; line: number }[] = [];

  beforeAll(() => {
    callSites = typeScriptFiles(TEST_DIR).flatMap((file) => {
      const relative = relativePosix(file);
      return scanRecordHeartbeatCalls(relative, readFileSync(file, "utf8")).map((finding) => ({
        file: relative,
        line: finding.line,
      }));
    });
    found = [...new Set(callSites.map((finding) => finding.file))].sort();
    if (process.env.UPDATE_RECORD_HEARTBEAT_BASELINE === "1") {
      // Regenerate exactly the still-offending files and sync the ceiling.
      writeFileSync(BASELINE_FILE, found.map((entry) => `${entry}\n`).join(""));
      const self = fileURLToPath(import.meta.url);
      writeFileSync(
        self,
        readFileSync(self, "utf8").replace(
          /BASELINE_CEILING = \d+;/,
          `BASELINE_CEILING = ${found.length};`,
        ),
      );
    }
    baseline = readFileSync(BASELINE_FILE, "utf8").split(/\r?\n/).filter(Boolean);
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no file outside the baseline calls recordHeartbeat directly", () => {
    const added = callSites.filter((finding) => !baseline.includes(finding.file));
    if (added.length > 0) {
      throw new Error(
        `New direct recordHeartbeat calls:\n  ${added.map(({ file, line }) => `${file}:${line}`).join("\n  ")}\n` +
          `Drive heartbeats through test/helpers/livenessScenarioHarness.ts (daemon/heartbeat frames). ` +
          `For a genuine recordHeartbeat unit test, update with: ${UPDATE_COMMAND}  (then commit ` +
          `test/lint/record-heartbeat-callers-baseline.txt and this test file).`,
      );
    }
  });

  test("the baseline lists only still-offending files, so it can only shrink", () => {
    const stale = baseline.filter((entry) => !found.includes(entry));
    if (stale.length > 0) {
      throw new Error(
        `Stale baseline lines (file fixed, renamed or deleted):\n  ${stale.join("\n  ")}\n` +
          `Run: ${UPDATE_COMMAND}  and commit the result.`,
      );
    }
    expect(baseline.length).toBe(BASELINE_CEILING);
  });

  test("the baseline is sorted and free of duplicates", () => {
    expect(baseline).toEqual([...new Set(baseline)].sort());
  });

  test("the liveness scenario harness never calls recordHeartbeat directly or enters the baseline", () => {
    expect(found).not.toContain(HARNESS_FILE);
    expect(baseline).not.toContain(HARNESS_FILE);
  });
});
