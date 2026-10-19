import { basename } from "node:path";
import ts from "typescript";

export const OWNER = "src/utils/ios-cmdline-tools/AppBundleMetadataClient.ts";

// Production diagnostics must use AppBundleMetadataClient as well. Tests are not
// scanned, and any future source exception needs a documented entry here.
export const EXCEPTIONS = new Map<string, string>([
  [
    "src/utils/ios-cmdline-tools/CtrlProxyCodesignVerifier.ts",
    // Pre-launch integrity gate for the DOWNLOADED iOS helper (issue #4760): an
    // argv-only `codesign --verify --deep --strict` / `codesign -dvv` plus
    // `spctl --assess`. This is a launch-time signature/notarization control,
    // not entitlement-metadata inspection, and it also owns `spctl` (which
    // AppBundleMetadataClient has no business executing). Injection-safe: the
    // bundle path is passed as a single literal argv element, never a shell string.
    "CtrlProxy launch-gate signature/notarization verification (#4760).",
  ],
]);

const EXECUTION_METHODS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "execute",
  "execAsync",
  "hostExec",
  "spawn",
  "spawnSync",
]);

const staticString = (expression: ts.Expression): string | undefined => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(expression.left);
    const right = staticString(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

const isExecutionCall = (expression: ts.Expression): boolean => {
  if (ts.isIdentifier(expression)) {
    return EXECUTION_METHODS.has(expression.text);
  }
  return ts.isPropertyAccessExpression(expression) && EXECUTION_METHODS.has(expression.name.text);
};

export interface CodesignHit {
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export function directlyExecutesCodesign(file: string, source: string): CodesignHit[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const codesignAliases = new Set<string>();
  const violations: CodesignHit[] = [];
  const isCodesignExecutable = (expression: ts.Expression): boolean => {
    const value = staticString(expression);
    if (value !== undefined) {
      return basename(value) === "codesign";
    }
    if (ts.isIdentifier(expression)) {
      return codesignAliases.has(expression.text);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some(
        (element) => ts.isExpression(element) && isCodesignExecutable(element),
      );
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCodesignExecutable(node.initializer)
    ) {
      codesignAliases.add(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      isExecutionCall(node.expression) &&
      node.arguments.some(isCodesignExecutable)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        line: position.line + 1,
        column: position.character + 1,
        text: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}
