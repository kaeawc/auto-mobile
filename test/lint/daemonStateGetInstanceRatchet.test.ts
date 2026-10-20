import { typeScriptFiles, relativePosix, readGuardFile } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import { countDaemonStateGetInstanceCalls } from "./daemonStateGetInstanceCalls";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
// Parsing every src file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

type Counts = Record<string, number>;

/**
 * Files allowed to call DaemonState.getInstance() because they ARE the process-wide
 * composition seam: every other src file receives its daemon state as a dependency.
 * Any other src file that calls it is a violation.
 */
const EXEMPT_FILES: Readonly<Record<string, string>> = {
  "src/daemon/daemonContext.ts":
    "Daemon composition root: the single place that resolves the process-wide DaemonState singleton and hands it to collaborators.",
};

describe("countDaemonStateGetInstanceCalls", () => {
  test.each([
    "DaemonState.getInstance();",
    "DaemonState?.getInstance();",
    'DaemonState["getInstance"]();',
    "(DaemonState.getInstance)();",
    "DaemonState.getInstance().getSessionManager();",
    "DaemonState.getInstance!();",
    'import { DaemonState as State } from "../daemon/daemonState";\nState.getInstance();',
    'import * as ds from "../daemon/daemonState";\nds.DaemonState.getInstance();',
    "const S = DaemonState;\nconst T = S;\nT.getInstance();",
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

describe("DaemonState.getInstance() has no call sites in src/ outside the exemptions (#11806)", () => {
  const found: Counts = {};
  const exemptFound: Counts = {};

  beforeAll(() => {
    for (const file of typeScriptFiles(SRC_DIR)) {
      const source = readGuardFile(file);
      if (!source.includes("DaemonState")) {
        continue;
      }
      const count = countDaemonStateGetInstanceCalls(file, source);
      const relative = relativePosix(REPO_ROOT, file);
      if (count > 0) {
        (relative in EXEMPT_FILES ? exemptFound : found)[relative] = count;
      }
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no non-exempt file calls DaemonState.getInstance()", () => {
    const offenders = Object.keys(found).map((file) => `${file}: ${found[file]}`);
    expect(
      offenders,
      "Pass the daemon state (or the narrow service you need) in as a dependency instead of reaching for DaemonState.getInstance().",
    ).toEqual([]);
  });

  test("every exemption is still needed and says why", () => {
    const unused = Object.keys(EXEMPT_FILES).filter((file) => !(file in exemptFound));
    expect(
      unused,
      "Remove exemptions whose file no longer calls DaemonState.getInstance().",
    ).toEqual([]);
    const unexplained = Object.entries(EXEMPT_FILES)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([file]) => file);
    expect(unexplained).toEqual([]);
  });
});
