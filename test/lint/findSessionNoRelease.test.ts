import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { relativePosix, typeScriptFiles } from "./astGuard";
import { scanNamedCalls } from "./recordHeartbeatCallers";

const source = ts.createSourceFile(
  "sessionManager.ts",
  readFileSync(new URL("../../src/daemon/sessionManager.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const manager = source.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "SessionManager",
);
if (!manager) {
  throw new Error("SessionManager class not found");
}
const methods = manager.members.filter(ts.isMethodDeclaration);

// Retained expireIfDue paths use this.getSession to preserve instance patches (#12581).
// Counts must shrink with migrations; adding a reader requires an explicit expiry decision.
const RETAINED_EXPIRY_READERS: Readonly<Record<string, number>> = {
  recoverPersistedRow: 1,
  getDeviceForSession: 1,
  updateSessionCache: 1,
  setDisplayPin: 1,
  invalidateAutomationReadiness: 1,
  setDeviceLabels: 1,
  clearSessionCache: 1,
};

// The liveness lease and policy moved to SessionLivenessController (#11797). Its lookups reach
// SessionManager.getSession through `this.port.getSession` (an expiring lookup, as they were in
// class); the same per-method counts hold, and none may become findSession.
const RETAINED_LIVENESS_EXPIRY_READERS: Readonly<Record<string, number>> = {
  recordHeartbeat: 1,
  claimLivenessOwnership: 2,
  releaseLivenessOwnership: 2,
  hasLivenessOwnership: 1,
  claimUnownedLivenessOwnership: 1,
  adoptCliLivenessPolicy: 1,
  adoptManagedExecutionLivenessPolicy: 1,
  restoreHeartbeatLivenessPolicy: 1,
};

function callsIn(method: ts.MethodDeclaration, onlyThis = false): string[] {
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (!onlyThis || callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
          calls.push(callee.name.text);
        }
      } else if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteral(callee.argumentExpression) &&
        (!onlyThis || callee.expression.kind === ts.SyntaxKind.ThisKeyword)
      ) {
        calls.push(callee.argumentExpression.text);
      } else if (!onlyThis && ts.isIdentifier(callee)) {
        calls.push(callee.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (method.body) {
    visit(method.body);
  }
  return calls;
}

test("findSession contains no release or execution-cancellation call", () => {
  const find = methods.find((method) => method.name.getText(source) === "findSession");
  expect(find?.body).toBeDefined();
  if (!find?.body) {
    throw new Error("findSession body not found");
  }
  const forbidden = new Set([
    "releaseExpiredSessionLazily",
    "releaseSessionPastIdleDeadline",
    "releaseSession",
    "releaseSessionForReason",
    "cancelExecutionsOverriddenByExpiry",
  ]);
  expect(callsIn(find).filter((name) => forbidden.has(name))).toEqual([]);
});

test.each(["findSession", "expireIfDue"])("%s stays synchronous", (name) => {
  const method = methods.find((method) => method.name.getText(source) === name);
  expect(method?.body).toBeDefined();
  expect(
    method?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
  ).toBe(false);
  expect(method && callsIn(method)).not.toContain("then");
});

test("in-class getSession calls stay within the retained expiry reader inventory", () => {
  const actual = Object.fromEntries(
    methods.flatMap((method) => {
      const count = callsIn(method, true).filter((name) => name === "getSession").length;
      return count ? [[method.name.getText(source), count]] : [];
    }),
  );
  expect(actual).toEqual(RETAINED_EXPIRY_READERS);
});

test("the liveness controller's port getSession calls stay within the retained expiry reader inventory", () => {
  const controllerSource = ts.createSourceFile(
    "sessionLivenessLease.ts",
    readFileSync(new URL("../../src/daemon/sessionLivenessLease.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const controller = controllerSource.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === "SessionLivenessController",
  );
  expect(controller).toBeDefined();
  const counts: Record<string, number> = {};
  const visitMethod = (name: string, node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "getSession" &&
      node.expression.expression.getText(controllerSource) === "this.port"
    ) {
      counts[name] = (counts[name] ?? 0) + 1;
    }
    ts.forEachChild(node, (child) => visitMethod(name, child));
  };
  for (const member of controller?.members ?? []) {
    if (ts.isMethodDeclaration(member) && member.body) {
      visitMethod(member.name.getText(controllerSource), member.body);
    }
  }
  expect(counts).toEqual(RETAINED_LIVENESS_EXPIRY_READERS);
});

// Expiring `getSession(` calls left in src/server (#12581). Each is a mutation, release path,
// identity compare or routing/admission site where lazy expiry is observable; pure device reads
// use findSession. Counts may only shrink; a new pure reader must call findSession.
const RETAINED_SERVER_EXPIRY_READERS: Readonly<Record<string, number>> = {
  "ToolExecutionContext.ts": 2,
  "deviceLabelMapping.ts": 1,
  "deviceToolsStartDevice.ts": 1,
  "index.ts": 2,
  "planDeviceOwnership.ts": 1,
  "planExecutionOrchestrator.ts": 2,
  "sessionBiometricEnrollment.ts": 1,
  "sessionClock.ts": 1,
  "sessionLocation.ts": 5,
  "sessionNetworkCondition.ts": 1,
  "sessionRotation.ts": 1,
  "sessionScreenReader.ts": 1,
  "setActiveDevice.ts": 5,
  "toolRegistry.ts": 3,
  "webrtcStreamManager.ts": 1,
};

const SERVER_DIR = fileURLToPath(new URL("../../src/server/", import.meta.url));
// Parsing the whole src/server tree can exceed Bun's default hook limit on loaded runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 30_000;

function scanGetSession(source: string): { line: number }[] {
  return scanNamedCalls("fixture.ts", source, "getSession");
}

describe("getSession call detection", () => {
  test.each([
    "m.getSession(id);",
    "m.getSession?.(id);",
    'm["getSession"](id);',
    "m[`getSession`](id);",
    "m.getSession!(id);",
    "(m.getSession)(id);",
    "m.getSession.call(m, id);",
    "m.getSession.apply(m, [id]);",
    "m.getSession.bind(m)(id);",
  ])("counts: %s", (source) => {
    expect(scanGetSession(source)).toEqual([{ line: 1 }]);
  });

  test.each([
    "m.findSession(id);",
    "m.getSessionForNewExecution(id);",
    'const s = "m.getSession(id)";',
    "// m.getSession(id);",
    "const r = /m.getSession(id)/;",
    "class Fake { getSession(id: string) {} }",
    "expect(m.getSession).toHaveBeenCalled();",
  ])("ignores: %s", (source) => {
    expect(scanGetSession(source)).toEqual([]);
  });
});

describe("src/server expiring getSession readers", () => {
  let actual: Record<string, number> = {};

  beforeAll(() => {
    actual = Object.fromEntries(
      typeScriptFiles(SERVER_DIR).flatMap((file) => {
        const text = readFileSync(file, "utf8");
        if (!text.includes("getSession")) {
          return [];
        }
        const count = scanNamedCalls(file, text, "getSession").length;
        return count ? [[relativePosix(SERVER_DIR, file), count]] : [];
      }),
    );
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("calls stay within the retained expiry reader inventory", () => {
    expect(actual).toEqual(RETAINED_SERVER_EXPIRY_READERS);
  });
});
