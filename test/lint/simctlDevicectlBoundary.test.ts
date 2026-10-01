import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { executionBoundaryAst } from "../../scripts/lib/executionBoundaryAst";

const ROOT = join(import.meta.dir, "..", "..");

interface BoundaryOffender {
  readonly file: string;
  readonly concern: string;
}

const OWNED_CONCERNS = new Map<string, string>([
  ["pasteboard", "pasteboard"],
  ["boot", "lifecycle"],
  ["shutdown", "lifecycle"],
  ["erase", "lifecycle"],
  ["delete", "lifecycle"],
  ["clone", "lifecycle"],
  ["rename", "lifecycle"],
  ["privacy", "privacy"],
  ["keychain", "keychain reset"],
  ["push", "push"],
  ["addmedia", "addmedia"],
  ["spawn", "spawn"],
  ["get_app_container", "app-container access"],
  ["files", "app-container access"],
  ["copy", "app-container access"],
  ["terminate", "app termination"],
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function commandValues(ast: ReturnType<typeof executionBoundaryAst>, call: ts.CallExpression) {
  const values = call.arguments.flatMap((argument) => ast.strings(argument));
  const arrays = call.arguments.flatMap((argument) => ast.arrayAlternatives(argument) ?? []);
  return [
    ...values,
    ...arrays.flatMap((array) => array.flatMap((argument) => ast.strings(argument))),
  ];
}

function concernFor(
  values: readonly string[],
  call: ts.CallExpression,
  ast: ReturnType<typeof executionBoundaryAst>,
): string | undefined {
  const callee = call.expression.getText();
  if (
    ast.calleeName(call) === "terminateApp" &&
    /deviceTerminator|deviceAppManager|DeviceAppManager/.test(callee)
  ) {
    return "app termination";
  }
  const normalized = values.map((value) => value.toLowerCase());
  for (let index = 0; index < normalized.length; index++) {
    const value = normalized[index];
    if (value === "process" && normalized[index + 1] === "terminate") {
      return "app termination";
    }
    if (value === "info" && normalized[index + 1] === "files") {
      return "app-container access";
    }
    if (value === "keychain" && normalized[index + 1] === "reset") {
      return "keychain reset";
    }
    const concern = OWNED_CONCERNS.get(value);
    if (concern) {
      return concern;
    }
  }
  return undefined;
}

function nodeContainsSimulatorEvidence(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (
      (ts.isIdentifier(child) && /simulator|issimulator/i.test(child.text)) ||
      (ts.isStringLiteralLike(child) && /simulator/i.test(child.text))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isNegativeSimulatorGuard(node: ts.Expression): boolean {
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return nodeContainsSimulatorEvidence(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    const leftIsSimulator =
      ts.isStringLiteralLike(node.left) && node.left.text.toLowerCase() === "simulator";
    const rightIsSimulator =
      ts.isStringLiteralLike(node.right) && node.right.text.toLowerCase() === "simulator";
    const unequalSimulatorType =
      operator === ts.SyntaxKind.ExclamationEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ? leftIsSimulator || rightIsSimulator
        : false;
    const unequalTrue =
      (operator === ts.SyntaxKind.ExclamationEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      ((node.left.kind === ts.SyntaxKind.TrueKeyword &&
        nodeContainsSimulatorEvidence(node.right)) ||
        (node.right.kind === ts.SyntaxKind.TrueKeyword &&
          nodeContainsSimulatorEvidence(node.left)));
    const comparesFalse =
      (operator === ts.SyntaxKind.EqualsEqualsToken ||
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken) &&
      ((node.left.kind === ts.SyntaxKind.FalseKeyword &&
        nodeContainsSimulatorEvidence(node.right)) ||
        (node.right.kind === ts.SyntaxKind.FalseKeyword &&
          nodeContainsSimulatorEvidence(node.left)));
    return unequalSimulatorType || unequalTrue || comparesFalse;
  }
  return false;
}

/**
 * Scope is simulator-specific when the file, containing class/function, an enclosing
 * simulator guard's true branch, or an explicit simulator-UDID argument says so.
 * Generic device IDs and physical-device executor methods do not count. In particular,
 * a DeviceAppManager method with `if (isSimulator) return simctl...` remains physical
 * after that early return; the simulator evidence must enclose the devicectl call.
 */
function isSimulatorScoped(
  file: string,
  call: ts.CallExpression,
  ast: ReturnType<typeof executionBoundaryAst>,
): boolean {
  if (/(?:Simulator|SimCtl)/i.test(file)) {
    return true;
  }
  if (call.arguments.some((argument) => /simulator(?:Udid|Id)?/i.test(argument.getText()))) {
    return true;
  }
  let current: ts.Node = call;
  while (current.parent) {
    const parent = current.parent;
    if (
      (ts.isFunctionLike(parent) || ts.isClassLike(parent)) &&
      parent.name &&
      /simulator|simctl/i.test(parent.name.getText())
    ) {
      return true;
    }
    if (ts.isIfStatement(parent)) {
      const hasEvidence = nodeContainsSimulatorEvidence(parent.expression);
      const negativeGuard = isNegativeSimulatorGuard(parent.expression);
      if (
        hasEvidence &&
        ((parent.thenStatement === current && !negativeGuard) ||
          (parent.elseStatement === current && negativeGuard))
      ) {
        return true;
      }
    }
    if (ts.isConditionalExpression(parent)) {
      const hasEvidence = nodeContainsSimulatorEvidence(parent.condition);
      const negativeGuard = isNegativeSimulatorGuard(parent.condition);
      if (
        hasEvidence &&
        ((parent.whenTrue === current && !negativeGuard) ||
          (parent.whenFalse === current && negativeGuard))
      ) {
        return true;
      }
    }
    current = parent;
  }

  // Calls with explicitly simulator-named executor methods are scoped by their callee.
  const callee = ast.calleeName(call) ?? "";
  return /simulator|simctl/i.test(callee);
}

function isDevicectlExecution(
  ast: ReturnType<typeof executionBoundaryAst>,
  call: ts.CallExpression,
) {
  const isTerminationOwnerApi =
    ast.calleeName(call) === "terminateApp" &&
    /deviceTerminator|deviceAppManager|DeviceAppManager/.test(call.expression.getText());
  if (isTerminationOwnerApi) {
    return true;
  }
  if (!ast.isLauncher(call) && !ast.isExecutionSeam(call)) {
    return false;
  }
  const values = commandValues(ast, call).map((value) => value.toLowerCase());
  return values.includes("devicectl") || values.some((value) => /(?:^|\/)devicectl$/.test(value));
}

function findOffenders(source: string, file = "fixture.ts"): BoundaryOffender[] {
  const ast = executionBoundaryAst(source);
  return ast.calls.flatMap((call) => {
    const values = commandValues(ast, call);
    const concern = concernFor(values, call, ast);
    if (!concern || !isSimulatorScoped(file, call, ast) || !isDevicectlExecution(ast, call)) {
      return [];
    }
    return [{ file, concern }];
  });
}

const sourceOffenders = sourceFiles(join(ROOT, "src")).flatMap((file) => {
  const repoPath = relative(ROOT, file).replace(/\\/g, "/");
  return findOffenders(readFileSync(file, "utf8"), repoPath);
});

describe("simctl/devicectl simulator boundary (issue #8353)", () => {
  test("the source scan has no simulator routes to devicectl for simctl-owned concerns", () => {
    expect(sourceOffenders, JSON.stringify(sourceOffenders, null, 2)).toEqual([]);
  });

  test("flags simulator-scoped devicectl pasteboard calls", () => {
    expect(
      findOffenders(
        'if (isSimulator) { await executeCommand("xcrun", ["devicectl", "device", "pasteboard", "copy", text]); }',
      ),
    ).toEqual([{ file: "fixture.ts", concern: "pasteboard" }]);
  });

  test("allows physical-device devicectl concerns and simulator simctl calls", () => {
    expect(
      findOffenders(
        'await executeCommand("xcrun", ["devicectl", "device", "pasteboard", "copy", text]);',
      ),
    ).toEqual([]);
    expect(
      findOffenders(
        'if (!isSimulator) { await executeCommand("xcrun", ["devicectl", "device", "pasteboard", "copy", text]); }',
      ),
    ).toEqual([]);
    expect(
      findOffenders(
        'if (isSimulator) { await executeCommand("xcrun", ["simctl", "pbcopy", udid]); }',
      ),
    ).toEqual([]);
  });

  test("flags another owned concern and leaves physical process termination alone", () => {
    expect(
      findOffenders(
        'function terminateSimulatorApp() { execFile("xcrun", ["devicectl", "device", "process", "terminate", "--pid", pid]); }',
      ),
    ).toEqual([{ file: "fixture.ts", concern: "app termination" }]);
    expect(
      findOffenders(
        'await executeCommand("xcrun", ["devicectl", "device", "process", "terminate", "--pid", pid]);',
      ),
    ).toEqual([]);
    expect(
      findOffenders(
        "if (isSimulator) { await this.deviceTerminator.terminateApp(this.device.deviceId, bundleId); }",
      ),
    ).toEqual([{ file: "fixture.ts", concern: "app termination" }]);
  });
});
