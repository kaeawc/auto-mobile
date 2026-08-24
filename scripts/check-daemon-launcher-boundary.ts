import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src/daemon";
const OWNER = "src/daemon/DaemonLauncher.ts";
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const EXECUTION_FUNCTIONS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
]);

interface Violation {
  file: string;
  line: number;
  column: number;
  text: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [path]
        : [];
  });
}

function isChildProcessRequire(expression: ts.Expression): boolean {
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    CHILD_PROCESS_MODULES.has(expression.arguments[0].text)
  );
}

function isDiagnosticProcessTableCall(file: string, node: ts.CallExpression): boolean {
  const command = node.arguments[0];
  if (file !== "src/daemon/manager.ts" || !command || !ts.isStringLiteral(command)) {
    return false;
  }
  return command.text.startsWith("ps -eo ") || command.text.startsWith("powershell.exe ");
}

function violationsIn(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const importedExecutors = new Set<string>();
  const namespaces = new Set<string>();
  const violations: Violation[] = [];

  const record = (node: ts.CallExpression) => {
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
        namespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (EXECUTION_FUNCTIONS.has(imported)) {
            importedExecutors.add(specifier.name.text);
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
      namespaces.add(node.name.text);
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        if (isChildProcessRequire(node.initializer)) {
          namespaces.add(node.name.text);
        }
        if (ts.isIdentifier(node.initializer) && importedExecutors.has(node.initializer.text)) {
          importedExecutors.add(node.name.text);
        }
        if (
          ts.isPropertyAccessExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          namespaces.has(node.initializer.expression.text) &&
          EXECUTION_FUNCTIONS.has(node.initializer.name.text)
        ) {
          importedExecutors.add(node.name.text);
        }
      }
      if (ts.isObjectBindingPattern(node.name) && isChildProcessRequire(node.initializer)) {
        for (const element of node.name.elements) {
          const imported =
            element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
          if (ts.isIdentifier(element.name) && EXECUTION_FUNCTIONS.has(imported)) {
            importedExecutors.add(element.name.text);
          }
        }
      }
    }

    if (ts.isCallExpression(node) && !isDiagnosticProcessTableCall(file, node)) {
      const expression = node.expression;
      const direct = ts.isIdentifier(expression) && importedExecutors.has(expression.text);
      const namespaced =
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(expression.expression.text) &&
        EXECUTION_FUNCTIONS.has(expression.name.text);
      if (direct || namespaced) {
        record(node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

const violations = sourceFiles(SOURCE_ROOT)
  .filter((file) => file !== OWNER)
  .flatMap(violationsIn);

if (violations.length > 0) {
  console.error("error: daemon execution must use DaemonLauncher:");
  for (const violation of violations) {
    console.error(
      `${relative(SOURCE_ROOT, violation.file)}:${violation.line}:${violation.column}: ${violation.text}`,
    );
  }
  process.exit(1);
}

console.log("daemon-launcher-boundary: no direct production daemon invocations.");
