import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

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
  recordHeartbeat: 1,
  claimLivenessOwnership: 2,
  releaseLivenessOwnership: 2,
  hasLivenessOwnership: 1,
  claimUnownedLivenessOwnership: 1,
  adoptCliLivenessPolicy: 1,
  adoptManagedExecutionLivenessPolicy: 1,
  restoreHeartbeatLivenessPolicy: 1,
  clearSessionCache: 1,
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
