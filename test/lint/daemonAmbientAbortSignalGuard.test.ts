import {
  typeScriptFiles,
  relativePosix,
  readGuardFile,
  parseGuardSource,
  GuardVisitor as Visitor,
} from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";

/**
 * #15671: src/daemon passes cancellation explicitly. `getAbortSignal()` (the ambient
 * AsyncLocalStorage signal from src/utils/AbortContext.ts) may only be read at a boundary: an
 * entry point whose callers hold no explicit signal, or a seam that installs a combined signal.
 * Every such file is a named exemption with its reason; any other read fails.
 */
const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const DAEMON_DIR = path.join(REPO_ROOT, "src", "daemon");
// Parsing the daemon tree can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

const EXEMPT_FILES: Readonly<Record<string, string>> = {
  "src/daemon/devicePoolParts/assignment.ts":
    "pool entry points (assignDeviceToSession, tryAssignDevice, tryAssignUnownedDevice, getRefreshedInventory) whose callers hold no explicit signal",
  "src/daemon/devicePoolParts/discovery.ts":
    "settlePooledRuntimeIdentity entry point (reached from readiness with no signal) and the reconcile boundary that combines the caller's signal with the ambient one",
  "src/daemon/devicePoolParts/multiAllocation.ts":
    "the two multi-device allocation entry points default to the ambient signal; everything below them takes it explicitly",
  "src/daemon/devicePoolParts/targetDiscovery.ts":
    "documented entry points (bindOrReuseDeviceSession, pickUpRunningDevice, exact device discovery)",
  "src/daemon/sessionManager/recoveryPublication.ts":
    "combines the ambient signal with a local controller and re-installs it for recovery publication",
};

type Node = { type: string; [key: string]: unknown };

function isGetAbortSignal(callee: unknown): boolean {
  const node = callee as Node | undefined;
  if (node?.type === "Identifier") {
    return node.name === "getAbortSignal";
  }
  if (node?.type === "MemberExpression" || node?.type === "StaticMemberExpression") {
    const property = node.property as Node | undefined;
    return property?.type === "Identifier" && property.name === "getAbortSignal";
  }
  return false;
}

/** The number of `getAbortSignal()` calls in `source`. Comments and plain references do not count. */
export function countAmbientSignalReads(file: string, source: string): number {
  let count = 0;
  new Visitor({
    CallExpression(node) {
      if (isGetAbortSignal(node.callee)) {
        count += 1;
      }
    },
  }).visit(parseGuardSource(file, source));
  return count;
}

describe("countAmbientSignalReads", () => {
  test.each([
    "getAbortSignal();",
    "const s = signal ?? getAbortSignal();",
    "function f(signal = getAbortSignal()) {}",
    "AbortContext.getAbortSignal();",
  ])("counts a read: %s", (source) => {
    expect(countAmbientSignalReads("fixture.ts", source)).toBe(1);
  });

  test.each([
    "// getAbortSignal()",
    'const s = "getAbortSignal()";',
    "const port = { getSignal: getAbortSignal };",
    'import { getAbortSignal } from "../utils/AbortContext";',
  ])("ignores a non-read: %s", (source) => {
    expect(countAmbientSignalReads("fixture.ts", source)).toBe(0);
  });
});

describe("src/daemon reads the ambient abort signal only at named boundaries (#15671)", () => {
  const found: Record<string, number> = {};
  const exemptFound: Record<string, number> = {};

  beforeAll(() => {
    for (const file of typeScriptFiles(DAEMON_DIR)) {
      const source = readGuardFile(file);
      if (!source.includes("getAbortSignal")) {
        continue;
      }
      const count = countAmbientSignalReads(file, source);
      const relative = relativePosix(REPO_ROOT, file);
      if (count > 0) {
        (Object.hasOwn(EXEMPT_FILES, relative) ? exemptFound : found)[relative] = count;
      }
    }
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no non-exempt daemon file calls getAbortSignal()", () => {
    expect(
      Object.entries(found).map(([file, count]) => `${file}: ${count}`),
      "Pass the caller's signal down explicitly, or read the ambient signal at the entry point and add a reasoned exemption.",
    ).toEqual([]);
  });

  test("every exemption is still needed and says why", () => {
    expect(
      Object.keys(EXEMPT_FILES).filter((file) => !(file in exemptFound)),
      "Remove exemptions whose file no longer calls getAbortSignal().",
    ).toEqual([]);
    expect(
      Object.entries(EXEMPT_FILES)
        .filter(([, reason]) => reason.trim().length === 0)
        .map(([file]) => file),
    ).toEqual([]);
  });
});
