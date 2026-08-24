import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/ios-cmdline-tools/SimulatorTccSqliteClient.ts";
const SQLITE_COMMAND = "sqlite3";
const ARGV_EXECUTION_NAMES = new Set([
  "executeCommand",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);
const SHELL_EXECUTION_NAMES = new Set(["exec", "execSync"]);
const SHELL_COMMAND_NAMES = new Set(["sh", "bash", "zsh"]);

// Test files are outside SOURCE_ROOT. A production diagnostic exception must be
// listed here with its rationale before it can bypass the simulator-TCC owner.
const DOCUMENTED_DIAGNOSTIC_EXCEPTIONS = new Set<string>();

interface Violation {
  file: string;
  line: number;
  column: number;
  text: string;
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

function stringValue(node: ts.Expression | undefined): string | undefined {
  if (node && ts.isStringLiteral(node)) {
    return node.text;
  }
  if (node && ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function commandName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function isSqliteExecutablePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized === SQLITE_COMMAND || normalized.endsWith(`/${SQLITE_COMMAND}`);
}

function isShellExecutablePath(value: string): boolean {
  const name = value.replaceAll("\\", "/").split("/").at(-1);
  return name !== undefined && SHELL_COMMAND_NAMES.has(name);
}

function findViolations(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  if (!source.includes(SQLITE_COMMAND)) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];
  const sqliteCommandVariables = new Set<string>();
  const executionAliases = new Set<string>();

  const isSqliteCommand = (expression: ts.Expression | undefined): boolean => {
    const value = stringValue(expression);
    if (value !== undefined) {
      return isSqliteExecutablePath(value);
    }
    if (expression && ts.isIdentifier(expression)) {
      return sqliteCommandVariables.has(expression.text);
    }
    return expression?.getText(sourceFile).includes(SQLITE_COMMAND) ?? false;
  };

  const isSqliteExecutionArgument = (expression: ts.Expression | undefined): boolean => {
    if (expression && ts.isArrayLiteralExpression(expression)) {
      return isSqliteCommand(expression.elements[0]);
    }
    return isSqliteCommand(expression);
  };

  const containsSqliteCommand = (expression: ts.Expression | undefined): boolean => {
    if (!expression) {
      return false;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some(
        (element) => ts.isExpression(element) && containsSqliteCommand(element),
      );
    }
    return expression.getText(sourceFile).includes(SQLITE_COMMAND);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isSqliteCommand(node.initializer)) {
        sqliteCommandVariables.add(node.name.text);
      }
      const initializerName = commandName(node.initializer as ts.LeftHandSideExpression);
      if (
        initializerName &&
        (ARGV_EXECUTION_NAMES.has(initializerName) || executionAliases.has(initializerName))
      ) {
        executionAliases.add(node.name.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = commandName(node.expression);
      const firstArgument = stringValue(node.arguments[0]);
      const isArgvExecution =
        ARGV_EXECUTION_NAMES.has(name ?? "") || executionAliases.has(name ?? "");
      const isShellExecution =
        SHELL_EXECUTION_NAMES.has(name ?? "") || executionAliases.has(name ?? "");
      const directArgvSqlite = isArgvExecution && isSqliteExecutionArgument(node.arguments[0]);
      const directShellSqlite = isShellExecution && containsSqliteCommand(node.arguments[0]);
      const wrappedShellSqlite =
        isArgvExecution &&
        firstArgument !== undefined &&
        isShellExecutablePath(firstArgument) &&
        node.arguments.slice(1).some(containsSqliteCommand);
      if (directArgvSqlite || directShellSqlite || wrappedShellSqlite) {
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
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

const violations = sourceFiles(SOURCE_ROOT)
  .filter(
    (file) =>
      file.replaceAll("\\", "/") !== OWNER &&
      !DOCUMENTED_DIAGNOSTIC_EXCEPTIONS.has(file.replaceAll("\\", "/")),
  )
  .flatMap(findViolations);

if (violations.length > 0) {
  console.error("error: simulator TCC sqlite3 execution must use SimulatorTccSqliteClient:");
  for (const violation of violations) {
    console.error(
      `${relative(SOURCE_ROOT, violation.file)}:${violation.line}:${violation.column}: ${violation.text}`,
    );
  }
  process.exit(1);
}

console.log("simulator-tcc-sqlite-boundary: no direct production sqlite3 invocations.");
