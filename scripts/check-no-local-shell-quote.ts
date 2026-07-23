import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/shellQuote.ts";
const LOCAL_HELPER_NAMES = new Set(["shellQuote", "quoteShell", "quoteShellArg"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function isLocalHelperDeclaration(node: ts.Node): node is ts.FunctionDeclaration | ts.VariableDeclaration {
  if (ts.isFunctionDeclaration(node)) {
    return !!node.name && LOCAL_HELPER_NAMES.has(node.name.text);
  }
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    LOCAL_HELPER_NAMES.has(node.name.text) &&
    !!node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  );
}

function findViolations(file: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (isLocalHelperDeclaration(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        file,
        line: line + 1,
        column: character + 1,
        name: node.name.text,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

const violations = sourceFiles(SOURCE_ROOT)
  .filter(file => file !== OWNER)
  .flatMap(findViolations);

if (violations.length > 0) {
  console.error("error: production shell quoting must use src/utils/shellQuote.ts:");
  for (const violation of violations) {
    console.error(`${relative(SOURCE_ROOT, violation.file)}:${violation.line}:${violation.column}: ${violation.name}`);
  }
  process.exit(1);
}

console.log("shell-quote-boundary: no local production shell-quoting helpers.");
