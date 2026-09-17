import { readdirSync } from "node:fs";
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

export function repositoryPath(file: string): string {
  return file.replaceAll("\\", "/");
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

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticMemberName(expression: ts.Expression): string | undefined {
  const memberAccess = unwrapTransparentExpression(expression);
  if (ts.isPropertyAccessExpression(memberAccess)) {
    return memberAccess.name.text;
  }
  const elementAccessArgument =
    ts.isElementAccessExpression(memberAccess) && memberAccess.argumentExpression
      ? unwrapTransparentExpression(memberAccess.argumentExpression)
      : undefined;
  if (elementAccessArgument !== undefined && ts.isStringLiteralLike(elementAccessArgument)) {
    return elementAccessArgument.text;
  }
  return undefined;
}

function staticPropertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  const expression = ts.isComputedPropertyName(name)
    ? unwrapTransparentExpression(name.expression)
    : undefined;
  return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

function violationsIn(
  file: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Violation[] {
  const importedExecutors = new Set<ts.Symbol>();
  const namespaces = new Set<ts.Symbol>();
  const violations: Violation[] = [];
  let bindingsChanged = false;

  const symbolFor = (identifier: ts.Identifier): ts.Symbol | undefined =>
    checker.getSymbolAtLocation(identifier);
  const addBinding = (bindings: Set<ts.Symbol>, identifier: ts.Identifier): void => {
    const symbol = symbolFor(identifier);
    if (symbol && !bindings.has(symbol)) {
      bindings.add(symbol);
      bindingsChanged = true;
    }
  };
  const hasBinding = (bindings: Set<ts.Symbol>, identifier: ts.Identifier): boolean => {
    const symbol = symbolFor(identifier);
    return symbol !== undefined && bindings.has(symbol);
  };

  const record = (node: ts.CallExpression) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file,
      line: line + 1,
      column: character + 1,
      text: node.getText(sourceFile),
    });
  };

  const visit = (node: ts.Node, collectBindingsOnly: boolean): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)
    ) {
      const defaultBinding = node.importClause?.name;
      if (defaultBinding) {
        addBinding(namespaces, defaultBinding);
      }
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        addBinding(namespaces, bindings.name);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (EXECUTION_FUNCTIONS.has(imported)) {
            addBinding(importedExecutors, specifier.name);
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
      addBinding(namespaces, node.name);
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapTransparentExpression(node.initializer);
      if (ts.isIdentifier(node.name)) {
        if (isChildProcessRequire(initializer)) {
          addBinding(namespaces, node.name);
        }
        if (ts.isIdentifier(initializer) && hasBinding(importedExecutors, initializer)) {
          addBinding(importedExecutors, node.name);
        }
        if (ts.isIdentifier(initializer) && hasBinding(namespaces, initializer)) {
          addBinding(namespaces, node.name);
        }
        if (
          (ts.isPropertyAccessExpression(initializer) ||
            ts.isElementAccessExpression(initializer)) &&
          ts.isIdentifier(unwrapTransparentExpression(initializer.expression)) &&
          hasBinding(namespaces, unwrapTransparentExpression(initializer.expression)) &&
          EXECUTION_FUNCTIONS.has(staticMemberName(initializer) ?? "")
        ) {
          addBinding(importedExecutors, node.name);
        }
      }
      if (
        ts.isObjectBindingPattern(node.name) &&
        (isChildProcessRequire(initializer) ||
          (ts.isIdentifier(initializer) && hasBinding(namespaces, initializer)))
      ) {
        for (const element of node.name.elements) {
          const imported =
            staticPropertyName(element.propertyName) ??
            (ts.isIdentifier(element.name) ? element.name.text : undefined);
          if (ts.isIdentifier(element.name) && EXECUTION_FUNCTIONS.has(imported)) {
            addBinding(importedExecutors, element.name);
          }
        }
      }
    }

    if (
      !collectBindingsOnly &&
      ts.isCallExpression(node) &&
      !isDiagnosticProcessTableCall(file, node)
    ) {
      const expression = unwrapTransparentExpression(node.expression);
      const direct = ts.isIdentifier(expression) && hasBinding(importedExecutors, expression);
      const namespaced =
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        ts.isIdentifier(unwrapTransparentExpression(expression.expression)) &&
        hasBinding(namespaces, unwrapTransparentExpression(expression.expression)) &&
        EXECUTION_FUNCTIONS.has(staticMemberName(expression) ?? "");
      if (direct || namespaced) {
        record(node);
      }
    }
    ts.forEachChild(node, (child) => visit(child, collectBindingsOnly));
  };

  do {
    bindingsChanged = false;
    visit(sourceFile, true);
  } while (bindingsChanged);
  visit(sourceFile, false);
  return violations;
}

export function findViolations(): Violation[] {
  const files = sourceFiles(SOURCE_ROOT);
  const program = ts.createProgram(files, { noEmit: true, noLib: true, noResolve: true });
  const checker = program.getTypeChecker();
  return files
    .filter((file) => repositoryPath(file) !== OWNER)
    .flatMap((file) => {
      const sourceFile = program.getSourceFile(file);
      return sourceFile ? violationsIn(file, sourceFile, checker) : [];
    });
}

if (import.meta.main) {
  const violations = findViolations();
  if (violations.length > 0) {
    console.error("error: daemon execution must use DaemonLauncher:");
    for (const violation of violations) {
      console.error(
        `${repositoryPath(relative(SOURCE_ROOT, violation.file))}:${violation.line}:${violation.column}: ${violation.text}`,
      );
    }
    process.exit(1);
  }

  console.log("daemon-launcher-boundary: no direct production daemon invocations.");
}
