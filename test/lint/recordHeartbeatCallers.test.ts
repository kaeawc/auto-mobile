import { typeScriptFiles, relativePosix, readGuardFile } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import {
  scanRecordHeartbeatCalls,
  scanNamedCalls,
  scanNamedCallOwners,
} from "./recordHeartbeatCallers";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const TEST_DIR = path.join(REPO_ROOT, "test");
// Parsing every test file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;
const HARNESS_FILE = "test/helpers/livenessScenarioHarness.ts";
/**
 * Files that unit-test `recordHeartbeat` itself, so the direct call IS the subject under test and
 * delivering a `daemon/heartbeat` frame would test a different layer. A permanent, reasoned
 * exemption: an exempt file must still call it (else drop the entry).
 */
const EXEMPT_FILES: Readonly<Record<string, string>> = {
  "test/daemon/sessionLivenessLease.test.ts":
    "unit-tests SessionLivenessController.recordHeartbeat (lease state machine) directly",
  "test/daemon/sessionManager.heartbeat.test.ts":
    "unit-tests SessionManager.recordHeartbeat (its activity and lease effects) directly",
};

describe("scanRecordHeartbeatCalls", () => {
  test.each([
    "manager.recordHeartbeat(sessionId);",
    "manager?.recordHeartbeat(sessionId);",
    'manager["recordHeartbeat"](sessionId);',
    "recordHeartbeat(sessionId);",
    "manager.recordHeartbeat?.(sessionId);",
    'manager?.["recordHeartbeat"](sessionId);',
    'manager["record\\u0048eartbeat"](sessionId);',
    "manager.recordHeartbeat.call(manager, id);",
    "manager.recordHeartbeat.apply(manager, [id]);",
    "manager.recordHeartbeat.bind(manager)(id);",
    "(manager.recordHeartbeat)(id);",
    "(0, manager.recordHeartbeat)(id);",
    "(manager.recordHeartbeat as any)(id);",
    "manager.recordHeartbeat!(id);",
    "(manager.recordHeartbeat satisfies F)(id);",
    "manager[`recordHeartbeat`](id);",
    "recordHeartbeat.call(manager, id);",
    "recordHeartbeat.apply(manager, [id]);",
    "recordHeartbeat.bind(manager)(id);",
    "((0, (manager.recordHeartbeat as F))!).call(manager, id);",
  ])("flags a direct call: %s", (source) => {
    expect(scanRecordHeartbeatCalls("fixture.ts", source)).toEqual([{ line: 1 }]);
  });

  test.each([
    "class Fake { recordHeartbeat(id: string) {} }",
    "const fake = { recordHeartbeat(id: string) {} };",
    "interface Manager { recordHeartbeat(id: string): void; }",
    'spyOn(m, "recordHeartbeat");',
    "expect(m.recordHeartbeat).toHaveBeenCalled();",
    "recordHeartbeatAt(id);",
    "manager.recordHeartbeatAt.call(manager, id);",
    'const mention = "manager.recordHeartbeat(id)";',
    "// manager.recordHeartbeat(id);",
    "m[`record${x}`](id);",
    "(manager.recordHeartbeat, other)(id);",
  ])("ignores a non-call or a different callee: %s", (source) => {
    expect(scanRecordHeartbeatCalls("fixture.ts", source)).toEqual([]);
  });

  test("reports both calls on their correct lines", () => {
    expect(
      scanRecordHeartbeatCalls(
        "fixture.ts",
        "\nmanager.recordHeartbeat(id);\n\nrecordHeartbeat(id);",
      ),
    ).toEqual([{ line: 2 }, { line: 4 }]);
    for (const name of ["foo\nbar", 'foo"bar', "foo/bar", "foo\\bar"]) {
      const source = `manager[${JSON.stringify(name).replaceAll("/", "\\/")}]();`;
      expect(scanNamedCalls("fixture.ts", source, name)).toEqual([{ line: 1 }]);
      expect(scanNamedCallOwners("fixture.ts", source, name)).toEqual(["<module>"]);
    }
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

describe("tests do not call recordHeartbeat directly", () => {
  let found: readonly string[] = [];
  let exemptFound: readonly string[] = [];
  let callSites: readonly { file: string; line: number }[] = [];

  beforeAll(() => {
    callSites = typeScriptFiles(TEST_DIR).flatMap((file) => {
      const relative = relativePosix(REPO_ROOT, file);
      return scanRecordHeartbeatCalls(relative, readGuardFile(file)).map((finding) => ({
        file: relative,
        line: finding.line,
      }));
    });
    exemptFound = [...new Set(callSites.map((finding) => finding.file))].filter(
      (file) => file in EXEMPT_FILES,
    );
    callSites = callSites.filter((finding) => !(finding.file in EXEMPT_FILES));
    found = [...new Set(callSites.map((finding) => finding.file))].sort();
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no file calls recordHeartbeat directly", () => {
    if (callSites.length > 0) {
      throw new Error(
        `Direct recordHeartbeat calls:\n  ${callSites.map(({ file, line }) => `${file}:${line}`).join("\n  ")}\n` +
          `Drive heartbeats through deliverDaemonHeartbeat in test/helpers/daemonHeartbeatHandler.ts ` +
          `(daemon/heartbeat frames). A test that unit-tests recordHeartbeat itself belongs in ` +
          `EXEMPT_FILES with a reason.`,
      );
    }
  });

  test("every exemption names a file that still calls recordHeartbeat directly", () => {
    const unused = Object.keys(EXEMPT_FILES).filter((file) => !exemptFound.includes(file));
    expect(unused).toEqual([]);
    for (const reason of Object.values(EXEMPT_FILES)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  test("the liveness scenario harness never calls recordHeartbeat directly", () => {
    expect(found).not.toContain(HARNESS_FILE);
  });
});
