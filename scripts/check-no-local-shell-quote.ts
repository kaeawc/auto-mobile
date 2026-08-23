import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const SOURCE_ROOT = process.env.SHELL_QUOTE_SOURCE_ROOT ?? "src";
const OWNER = join(SOURCE_ROOT, "utils/shellQuote.ts");
const LOCAL_HELPER_NAMES = new Set(["shellQuote", "quoteShell", "quoteShellArg"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function isBannedHelperName(
  name: ts.DeclarationName | ts.PropertyName | undefined,
): name is ts.Identifier {
  return !!name && ts.isIdentifier(name) && LOCAL_HELPER_NAMES.has(name.text);
}

function isFunctionValue(expression: ts.Expression | undefined): boolean {
  return !!expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression));
}

function isSingleQuoteEscapeCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) {
    return false;
  }
  const call = expression;
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !["replace", "replaceAll"].includes(call.expression.name.text) ||
    call.arguments.length !== 2
  ) {
    return false;
  }
  const [search, replacement] = call.arguments;
  const replacesSingleQuotes =
    (ts.isRegularExpressionLiteral(search) && search.text === "/'/g") ||
    (ts.isStringLiteral(search) && search.text === "'");
  return (
    replacesSingleQuotes &&
    ts.isStringLiteral(replacement) &&
    ["'\\''", "'\"'\"'"].includes(replacement.text)
  );
}

function isCanonicalShellQuoteExpression(expression: ts.Expression): boolean {
  if (
    !ts.isTemplateExpression(expression) ||
    expression.head.text !== "'" ||
    expression.templateSpans.length !== 1
  ) {
    return false;
  }
  const [span] = expression.templateSpans;
  return !!span && span.literal.text === "'" && isSingleQuoteEscapeCall(span.expression);
}

function containsSingleQuoteEscapeCall(node: ts.Node): boolean {
  if (ts.isExpression(node) && isSingleQuoteEscapeCall(node)) {
    return true;
  }
  return ts.forEachChild(node, containsSingleQuoteEscapeCall) ?? false;
}

function hasLocalShellQuoteImplementation(body: ts.Block | ts.Expression | undefined): boolean {
  if (!body) {
    return false;
  }
  if (!ts.isBlock(body)) {
    return isCanonicalShellQuoteExpression(body) || containsSingleQuoteEscapeCall(body);
  }
  return containsSingleQuoteEscapeCall(body);
}

function localHelperName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    if (isBannedHelperName(node.name)) {
      return node.name.text;
    }
    return hasLocalShellQuoteImplementation(node.body) && node.name ? node.name.getText() : null;
  }
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertyAssignment(node)) &&
    isBannedHelperName(node.name) &&
    isFunctionValue(node.initializer)
  ) {
    return node.name.text;
  }
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertyAssignment(node)) &&
    !isBannedHelperName(node.name) &&
    isFunctionValue(node.initializer) &&
    hasLocalShellQuoteImplementation(node.initializer.body)
  ) {
    return node.name.getText();
  }
  return null;
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
    const name = localHelperName(node);
    if (name) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({
        file,
        line: line + 1,
        column: character + 1,
        name,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

const violations = sourceFiles(SOURCE_ROOT)
  .filter((file) => file !== OWNER)
  .flatMap(findViolations);

if (violations.length > 0) {
  console.error("error: production shell quoting must use src/utils/shellQuote.ts:");
  for (const violation of violations) {
    console.error(
      `${relative(SOURCE_ROOT, violation.file)}:${violation.line}:${violation.column}: ${violation.name}`,
    );
  }
  process.exit(1);
}

console.log("shell-quote-boundary: no local production shell-quoting helpers.");
