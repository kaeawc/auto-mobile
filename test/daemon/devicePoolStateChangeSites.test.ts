import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

// #11413: every pool-family function that writes a device's status or holder must also tell
// resource subscribers. A new un-notified write fails here instead of leaving stale subscribers.
const POOL_FAMILY_FILES = [
  "src/daemon/devicePool.ts",
  "src/daemon/deviceReplacement.ts",
  "src/daemon/missingDeviceLiveness.ts",
  "src/daemon/sessionPreservingRecovery.ts",
  "src/daemon/adbServerResetQuarantine.ts",
  "src/daemon/deviceAutolockManager.ts",
];
const NOTIFY_CALLEES = new Set([
  "notifyDeviceStateChanged",
  "noteDeviceStateChanged",
  "noteStateChanged",
]);
// Arrow callbacks (lock bodies, timers) belong to the named function that wrote the state.
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression"]);
const STATE_PROPERTIES = new Set(["status", "sessionId"]);

/** Functions whose writes only roll a failed, never-notified claim back to its prior state. */
const ROLLBACK_ONLY = new Set(["devicePool.ts#restoreSessionAssignment"]);

/** Functions whose `sessionId` write targets a recovery reservation record, not a pooled device. */
const NOT_A_DEVICE_WRITE = new Set(["adbServerResetQuarantine.ts#reserveAdbServerResetRecovery"]);

type AstNode = { type: string; [key: string]: unknown };

interface FunctionScan {
  name: string;
  writes: number;
  notifies: number;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function propertyName(node: AstNode): string | undefined {
  const property = node.property as AstNode | undefined;
  return property?.type === "Identifier" ? (property.name as string) : undefined;
}

function calleeName(node: AstNode): string | undefined {
  const callee = node.callee as AstNode | undefined;
  if (callee?.type === "Identifier") {
    return callee.name as string;
  }
  return callee?.type === "MemberExpression" ? propertyName(callee) : undefined;
}

function scanFile(path: string): FunctionScan[] {
  const source = readFileSync(path, "utf8");
  const program = parseSync(path, source).program as unknown as AstNode;
  const scans: FunctionScan[] = [];
  const stack: FunctionScan[] = [];

  const walk = (node: AstNode, methodName: string | undefined): void => {
    let scan: FunctionScan | undefined;
    if (FUNCTION_TYPES.has(node.type)) {
      const id = node.id as AstNode | undefined;
      scan = { name: (id?.name as string) ?? methodName ?? "<anonymous>", writes: 0, notifies: 0 };
      scans.push(scan);
      stack.push(scan);
    }
    const current = stack[stack.length - 1];
    if (current && node.type === "AssignmentExpression") {
      const left = node.left as AstNode;
      if (left.type === "MemberExpression" && STATE_PROPERTIES.has(propertyName(left) ?? "")) {
        current.writes++;
      }
    }
    if (current && node.type === "CallExpression" && NOTIFY_CALLEES.has(calleeName(node) ?? "")) {
      current.notifies++;
    }
    for (const [key, value] of Object.entries(node)) {
      const nextMethod =
        node.type === "MethodDefinition" && key === "value"
          ? (((node.key as AstNode).name as string | undefined) ?? methodName)
          : methodName;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (isNode(child)) {
          walk(child, nextMethod);
        }
      }
    }
    if (scan) {
      stack.pop();
    }
  };
  walk(program, undefined);
  return scans;
}

describe("pool status/holder mutation sites notify subscribers (#11413)", () => {
  const cases = POOL_FAMILY_FILES.flatMap((path) =>
    scanFile(path)
      .filter((scan) => scan.writes > 0)
      .map((scan) => ({ path, scan })),
  );

  test("the scan finds the known mutation sites", () => {
    const names = cases.map(({ scan }) => scan.name);
    for (const expected of [
      "releaseSessionForEvictedDevice",
      "detachSessionForAndroidRecovery",
      "assignDeviceToBoundSession",
      "detachAdbServerResetCohort",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test.each(cases.map(({ path, scan }) => [`${path} ${scan.name}`, path, scan] as const))(
    "%s notifies after writing status or holder",
    (_label, path, scan) => {
      const key = `${path.split("/").pop()}#${scan.name}`;
      if (NOT_A_DEVICE_WRITE.has(key)) {
        return;
      }
      if (ROLLBACK_ONLY.has(key)) {
        expect(scan.notifies).toBe(0);
        return;
      }
      expect(scan.notifies).toBeGreaterThan(0);
    },
  );
});
