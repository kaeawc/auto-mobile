import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/android-cmdline-tools/AndroidEmulatorClient.ts";
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const CHILD_PROCESS_FUNCTIONS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
]);
const DIRECT_CHILD_PROCESS_FUNCTIONS = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
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

function isProcessExecutorType(type: ts.TypeNode | undefined): boolean {
  return (
    !!type &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "ProcessExecutor"
  );
}

function receiverName(
  expression: ts.Expression,
  processExecutors: Set<string>,
  childProcessNamespaces: Set<string>,
): string | null {
  if (ts.isIdentifier(expression)) {
    return processExecutors.has(expression.text) || childProcessNamespaces.has(expression.text)
      ? expression.text
      : null;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    processExecutors.has(expression.name.text)
  ) {
    return expression.getText();
  }
  return null;
}

function isChildProcessNamespace(
  expression: ts.Expression,
  childProcessNamespaces: Set<string>,
): boolean {
  return ts.isIdentifier(expression) && childProcessNamespaces.has(expression.text);
}

/**
 * Strip comments so the scope pre-filter below reflects what a file DOES, not
 * what it talks about. Without this, prose alone opts a file into the rule: a
 * doc comment on the iOS `SimCtlClient` that merely referenced the Android
 * emulator path pulled that file in and flagged its long-standing, legitimate
 * `spawn` in `defaultSpawnProcess`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function findViolations(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  // Scope: only files that actually execute emulator processes. This is a cheap
  // pre-filter, not the rule itself -- the AST walk below is what decides.
  if (!/emulator/i.test(stripComments(source))) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const processExecutors = new Set<string>();
  const childProcessNamespaces = new Set<string>();
  const childProcessFunctions = new Set<string>();
  const violations: Violation[] = [];

  const isChildProcessRequire = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    CHILD_PROCESS_MODULES.has(expression.arguments[0].text);

  const isChildProcessFunction = (expression: ts.Expression): boolean =>
    (ts.isIdentifier(expression) && childProcessFunctions.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) &&
      CHILD_PROCESS_FUNCTIONS.has(expression.name.text) &&
      isChildProcessNamespace(expression.expression, childProcessNamespaces));

  const record = (node: ts.CallExpression): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file,
      line: line + 1,
      column: character + 1,
      text: node.getText(sourceFile),
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        childProcessNamespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (CHILD_PROCESS_FUNCTIONS.has(imported)) {
            childProcessFunctions.add(specifier.name.text);
          }
        }
      }
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      CHILD_PROCESS_MODULES.has(node.moduleReference.expression.text)
    ) {
      childProcessNamespaces.add(node.name.text);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (
        isChildProcessRequire(node.initializer) ||
        isChildProcessNamespace(node.initializer, childProcessNamespaces)
      ) {
        childProcessNamespaces.add(node.name.text);
      }
      if (isChildProcessFunction(node.initializer)) {
        childProcessFunctions.add(node.name.text);
      }
    }

    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      isProcessExecutorType(node.type)
    ) {
      processExecutors.add(node.name.text);
    }

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        ts.isIdentifier(expression) &&
        (DIRECT_CHILD_PROCESS_FUNCTIONS.has(expression.text) ||
          childProcessFunctions.has(expression.text))
      ) {
        record(node);
      } else if (ts.isPropertyAccessExpression(expression)) {
        if (DIRECT_CHILD_PROCESS_FUNCTIONS.has(expression.name.text)) {
          record(node);
        } else if (
          (expression.name.text === "exec" &&
            receiverName(expression.expression, processExecutors, childProcessNamespaces)) ||
          isChildProcessFunction(expression)
        ) {
          record(node);
        }
      }
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
  console.error("error: Android emulator execution must use AndroidEmulatorClient:");
  for (const violation of violations) {
    console.error(
      `${relative(SOURCE_ROOT, violation.file)}:${violation.line}:${violation.column}: ${violation.text}`,
    );
  }
  process.exit(1);
}

console.log("android-emulator-boundary: no direct production emulator invocations.");
