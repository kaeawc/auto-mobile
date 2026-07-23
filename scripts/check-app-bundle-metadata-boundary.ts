import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/ios-cmdline-tools/AppBundleMetadataClient.ts";

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });

const EXECUTION_METHODS = new Set([
  "exec", "execFile", "execFileSync", "execSync", "execute", "execAsync",
  "hostExec", "spawn", "spawnSync",
]);

const staticString = (expression: ts.Expression): string | undefined => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
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

const directlyExecutesCodesign = (file: string): Array<{ line: number; column: number; text: string }> => {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const codesignAliases = new Set<string>();
  const violations: Array<{ line: number; column: number; text: string }> = [];
  const isCodesignExecutable = (expression: ts.Expression): boolean => {
    const value = staticString(expression);
    if (value !== undefined) {
      return basename(value) === "codesign";
    }
    if (ts.isIdentifier(expression)) {
      return codesignAliases.has(expression.text);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some(element => ts.isExpression(element) && isCodesignExecutable(element));
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
    if (ts.isCallExpression(node) && isExecutionCall(node.expression) && node.arguments.some(isCodesignExecutable)) {
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
};

// Production diagnostics must use AppBundleMetadataClient as well. Tests are not
// scanned, and any future source exception needs a documented entry here.
const exceptions = new Map<string, string>([]);
const violations = sourceFiles(SOURCE_ROOT)
  .map(file => ({ file, repoPath: relative(".", file) }))
  .filter(({ repoPath }) => repoPath !== OWNER && !exceptions.has(repoPath))
  .flatMap(({ file, repoPath }) => directlyExecutesCodesign(file).map(violation => ({ repoPath, ...violation })));

if (violations.length > 0) {
  console.error("error: codesign execution must use AppBundleMetadataClient:");
  for (const violation of violations) {
    console.error(`${violation.repoPath}:${violation.line}:${violation.column}: ${violation.text}`);
  }
  process.exit(1);
}

console.log("app-bundle-metadata-boundary: no direct production codesign invocations.");
