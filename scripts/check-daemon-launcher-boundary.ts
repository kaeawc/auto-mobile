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

function staticMemberName(
  expression: ts.Expression,
  staticStringValue?: (expression: ts.Expression) => string | undefined,
): string | undefined {
  const memberAccess = unwrapTransparentExpression(expression);
  if (ts.isPropertyAccessExpression(memberAccess)) {
    return memberAccess.name.text;
  }
  const elementAccessArgument =
    ts.isElementAccessExpression(memberAccess) && memberAccess.argumentExpression
      ? unwrapTransparentExpression(memberAccess.argumentExpression)
      : undefined;
  if (elementAccessArgument !== undefined) {
    return (
      staticStringValue?.(elementAccessArgument) ??
      (ts.isStringLiteralLike(elementAccessArgument) ? elementAccessArgument.text : undefined)
    );
  }
  return undefined;
}

function staticPropertyName(
  name: ts.PropertyName | undefined,
  staticStringValue?: (expression: ts.Expression) => string | undefined,
): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  const expression = ts.isComputedPropertyName(name)
    ? unwrapTransparentExpression(name.expression)
    : undefined;
  return expression
    ? (staticStringValue?.(expression) ??
        (ts.isStringLiteralLike(expression) ? expression.text : undefined))
    : undefined;
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

  const staticStringValue = (
    expression: ts.Expression,
    seen: Set<ts.Symbol> = new Set(),
  ): string | undefined => {
    const value = unwrapTransparentExpression(expression);
    if (ts.isStringLiteralLike(value)) {
      return value.text;
    }
    if (!ts.isIdentifier(value)) {
      return undefined;
    }
    const symbol = symbolFor(value);
    const declaration = symbol?.valueDeclaration;
    if (
      !symbol ||
      seen.has(symbol) ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return undefined;
    }
    seen.add(symbol);
    return staticStringValue(declaration.initializer, seen);
  };

  const isNamespaceExecutor = (value: ts.Expression): boolean => {
    const memberAccess = unwrapTransparentExpression(value);
    return (
      (ts.isPropertyAccessExpression(memberAccess) || ts.isElementAccessExpression(memberAccess)) &&
      ts.isIdentifier(unwrapTransparentExpression(memberAccess.expression)) &&
      hasBinding(namespaces, unwrapTransparentExpression(memberAccess.expression)) &&
      EXECUTION_FUNCTIONS.has(staticMemberName(memberAccess, staticStringValue) ?? "")
    );
  };

  const registerIdentifierBinding = (identifier: ts.Identifier, value: ts.Expression): void => {
    if (isChildProcessRequire(value)) {
      addBinding(namespaces, identifier);
    }
    if (ts.isIdentifier(value) && hasBinding(importedExecutors, value)) {
      addBinding(importedExecutors, identifier);
    }
    if (ts.isIdentifier(value) && hasBinding(namespaces, value)) {
      addBinding(namespaces, identifier);
    }
    if (isNamespaceExecutor(value)) {
      addBinding(importedExecutors, identifier);
    }
  };

  const registerObjectBinding = (
    elements: readonly ts.BindingElement[],
    value: ts.Expression,
  ): void => {
    if (
      !isChildProcessRequire(value) &&
      !(ts.isIdentifier(value) && hasBinding(namespaces, value))
    ) {
      return;
    }
    for (const element of elements) {
      const imported =
        staticPropertyName(element.propertyName, staticStringValue) ??
        (ts.isIdentifier(element.name) ? element.name.text : undefined);
      if (
        ts.isIdentifier(element.name) &&
        isUnreassignedInitializer(element.name) &&
        EXECUTION_FUNCTIONS.has(imported)
      ) {
        addBinding(importedExecutors, element.name);
      }
    }
  };

  const assignmentCounts = new Map<ts.Symbol, number>();
  const countAssignmentTarget = (target: ts.Expression): void => {
    const unwrappedTarget = unwrapTransparentExpression(target);
    if (ts.isIdentifier(unwrappedTarget)) {
      const symbol = symbolFor(unwrappedTarget);
      if (symbol) {
        assignmentCounts.set(symbol, (assignmentCounts.get(symbol) ?? 0) + 1);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(unwrappedTarget)) {
      for (const property of unwrappedTarget.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
          countAssignmentTarget(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          countAssignmentTarget(property.name);
        }
      }
    }
  };
  const countAssignments = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      countAssignmentTarget(node.left);
    }
    ts.forEachChild(node, countAssignments);
  };
  countAssignments(sourceFile);

  const isUnreassignedInitializer = (identifier: ts.Identifier): boolean => {
    const symbol = symbolFor(identifier);
    return symbol !== undefined && assignmentCounts.get(symbol) === undefined;
  };

  // Mutable or multiply assigned values are dynamic: only follow the one static
  // write into an otherwise uninitialized symbol.
  const isUnambiguousAssignmentTarget = (identifier: ts.Identifier): boolean => {
    const symbol = symbolFor(identifier);
    const declaration = symbol?.valueDeclaration;
    return (
      symbol !== undefined &&
      assignmentCounts.get(symbol) === 1 &&
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === undefined
    );
  };

  const registerObjectAssignment = (
    properties: readonly ts.ObjectLiteralElementLike[],
    value: ts.Expression,
  ): void => {
    if (
      !isChildProcessRequire(value) &&
      !(ts.isIdentifier(value) && hasBinding(namespaces, value))
    ) {
      return;
    }
    for (const property of properties) {
      const target = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined;
      if (!target || !ts.isIdentifier(target) || !isUnambiguousAssignmentTarget(target)) {
        continue;
      }
      const propertyName = ts.isPropertyAssignment(property) ? property.name : undefined;
      const imported = staticPropertyName(propertyName, staticStringValue) ?? target.text;
      if (EXECUTION_FUNCTIONS.has(imported)) {
        addBinding(importedExecutors, target);
      }
    }
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
      if (ts.isIdentifier(node.name) && isUnreassignedInitializer(node.name)) {
        registerIdentifierBinding(node.name, initializer);
      }
      if (ts.isObjectBindingPattern(node.name)) {
        registerObjectBinding(node.name.elements, initializer);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const value = unwrapTransparentExpression(node.right);
      const target = unwrapTransparentExpression(node.left);
      if (ts.isIdentifier(target) && isUnambiguousAssignmentTarget(target)) {
        registerIdentifierBinding(target, value);
      }
      if (ts.isObjectLiteralExpression(target)) {
        registerObjectAssignment(target.properties, value);
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
        EXECUTION_FUNCTIONS.has(staticMemberName(expression, staticStringValue) ?? "");
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
