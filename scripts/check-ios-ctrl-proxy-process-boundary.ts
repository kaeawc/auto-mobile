import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/ios/IOSCtrlProxyProcessClient.ts";
const PROCESS_TOOLS = new Set(["ps", "pgrep", "kill", "lsof"]);
const EXECUTION_METHODS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "executeCommand",
  "spawn",
  "spawnSync",
]);
const EXCEPTIONS = new Map<string, string>([
  [
    "src/features/performance/PerformanceMonitor.ts",
    "Collects app metrics, not CtrlProxy lifecycle state.",
  ],
]);

export function repositoryPath(file: string): string {
  return relative(".", file).replaceAll("\\", "/");
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function commandFromCall(node: ts.CallExpression): string | null {
  const firstArgument = node.arguments[0];
  if (ts.isStringLiteral(firstArgument)) {
    return firstArgument.text;
  }
  if (ts.isArrayLiteralExpression(firstArgument) && ts.isStringLiteral(firstArgument.elements[0])) {
    return firstArgument.elements[0].text;
  }
  return null;
}

function executesProcessTool(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    return EXECUTION_METHODS.has(expression.text) && PROCESS_TOOLS.has(commandFromCall(node) ?? "");
  }
  if (!ts.isPropertyAccessExpression(expression) || !EXECUTION_METHODS.has(expression.name.text)) {
    return false;
  }
  return PROCESS_TOOLS.has(commandFromCall(node) ?? "");
}

export function findViolationsInSource(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && executesProcessTool(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({
        file,
        line: line + 1,
        column: character + 1,
        text: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function findViolations(): Violation[] {
  return sourceFiles(SOURCE_ROOT)
    .filter((file) => repositoryPath(file) !== OWNER && !EXCEPTIONS.has(repositoryPath(file)))
    .flatMap((file) => findViolationsInSource(file, readFileSync(file, "utf8")));
}

if (import.meta.main) {
  const violations = findViolations();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}:${violation.column}: ${violation.text}`);
    }
    process.exit(1);
  }
  console.log("ios-ctrl-proxy-process-boundary: no direct production PID tooling.");
}
