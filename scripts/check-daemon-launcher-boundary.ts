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

interface BindingWrite {
  position: number;
  operator?: ts.SyntaxKind;
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
  const namespaceExclusions = new Map<ts.Symbol, ReadonlySet<string>>();
  const bindingTimings = new Map<ts.Symbol, { startsAt: number; endsAt?: number }>();
  const assignmentPositions = new Map<ts.Symbol, BindingWrite[]>();
  const violations: Violation[] = [];
  let bindingsChanged = false;

  const symbolFor = (identifier: ts.Identifier): ts.Symbol | undefined =>
    checker.getSymbolAtLocation(identifier);
  const recordTiming = (
    identifier: ts.Identifier,
    timing: { startsAt: number; endsAt?: number },
  ): void => {
    const symbol = symbolFor(identifier);
    if (symbol && !bindingTimings.has(symbol)) {
      bindingTimings.set(symbol, timing);
    }
  };
  const addBinding = (
    bindings: Set<ts.Symbol>,
    identifier: ts.Identifier,
    timing = { startsAt: 0 },
  ): void => {
    const symbol = symbolFor(identifier);
    if (symbol && !bindings.has(symbol)) {
      bindings.add(symbol);
      bindingsChanged = true;
    }
    recordTiming(identifier, timing);
  };
  const hasBinding = (bindings: Set<ts.Symbol>, identifier: ts.Identifier): boolean => {
    const symbol = symbolFor(identifier);
    return symbol !== undefined && bindings.has(symbol);
  };
  const bindingIsAvailableAt = (identifier: ts.Identifier, position: number): boolean => {
    const symbol = symbolFor(identifier);
    const timing = symbol ? bindingTimings.get(symbol) : undefined;
    return (
      timing !== undefined &&
      timing.startsAt <= position &&
      (timing.endsAt === undefined || position < timing.endsAt)
    );
  };
  const addNamespace = (
    identifier: ts.Identifier,
    exclusions: ReadonlySet<string> = new Set(),
    timing = { startsAt: 0 },
  ): void => {
    const symbol = symbolFor(identifier);
    if (symbol && !namespaceExclusions.has(symbol)) {
      namespaceExclusions.set(symbol, new Set(exclusions));
      bindingsChanged = true;
    }
    recordTiming(identifier, timing);
  };
  const namespaceExclusionsFor = (identifier: ts.Identifier): ReadonlySet<string> | undefined => {
    const symbol = symbolFor(identifier);
    return symbol ? namespaceExclusions.get(symbol) : undefined;
  };
  const hasNamespace = (identifier: ts.Identifier): boolean =>
    namespaceExclusionsFor(identifier) !== undefined;

  const namespaceIsAvailableAt = (identifier: ts.Identifier, position: number): boolean =>
    hasNamespace(identifier) && bindingIsAvailableAt(identifier, position);

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
    const receiver =
      ts.isPropertyAccessExpression(memberAccess) || ts.isElementAccessExpression(memberAccess)
        ? unwrapTransparentExpression(memberAccess.expression)
        : undefined;
    const executor = staticMemberName(memberAccess, staticStringValue);
    return (
      (ts.isPropertyAccessExpression(memberAccess) || ts.isElementAccessExpression(memberAccess)) &&
      receiver !== undefined &&
      ts.isIdentifier(receiver) &&
      hasNamespace(receiver) &&
      executor !== undefined &&
      EXECUTION_FUNCTIONS.has(executor) &&
      !namespaceExclusionsFor(receiver)?.has(executor)
    );
  };

  const registerIdentifierBinding = (
    identifier: ts.Identifier,
    value: ts.Expression,
    timing: { startsAt: number; endsAt?: number },
  ): void => {
    if (isChildProcessRequire(value)) {
      addNamespace(identifier, new Set(), timing);
    }
    if (ts.isIdentifier(value) && hasBinding(importedExecutors, value)) {
      addBinding(importedExecutors, identifier, timing);
    }
    if (ts.isIdentifier(value) && hasNamespace(value)) {
      addNamespace(identifier, namespaceExclusionsFor(value), timing);
    }
    if (isNamespaceExecutor(value)) {
      addBinding(importedExecutors, identifier, timing);
    }
  };

  const registerObjectBinding = (
    elements: readonly ts.BindingElement[],
    value: ts.Expression,
  ): void => {
    if (!isChildProcessRequire(value) && !(ts.isIdentifier(value) && hasNamespace(value))) {
      return;
    }
    const sourceExclusions = ts.isIdentifier(value) ? namespaceExclusionsFor(value) : undefined;
    const restExclusions = new Set(sourceExclusions);
    let hasDynamicExclusion = false;
    for (const element of elements) {
      if (element.dotDotDotToken) {
        continue;
      }
      const propertyName = staticPropertyName(element.propertyName, staticStringValue);
      const imported =
        propertyName ??
        (element.propertyName
          ? undefined
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined);
      if (imported === undefined) {
        hasDynamicExclusion = true;
        continue;
      }
      if (EXECUTION_FUNCTIONS.has(imported)) {
        restExclusions.add(imported);
      }
      if (
        ts.isIdentifier(element.name) &&
        EXECUTION_FUNCTIONS.has(imported) &&
        !sourceExclusions?.has(imported)
      ) {
        addBinding(importedExecutors, element.name, initializerTiming(element.name));
      }
    }
    if (hasDynamicExclusion) {
      return;
    }
    for (const element of elements) {
      if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
        addNamespace(element.name, restExclusions, initializerTiming(element.name));
      }
    }
  };

  const assignmentCounts = new Map<ts.Symbol, number>();
  const countAssignmentTarget = (target: ts.Expression, operator?: ts.SyntaxKind): void => {
    const unwrappedTarget = unwrapTransparentExpression(target);
    if (ts.isIdentifier(unwrappedTarget)) {
      const symbol = symbolFor(unwrappedTarget);
      if (symbol) {
        assignmentCounts.set(symbol, (assignmentCounts.get(symbol) ?? 0) + 1);
        const writes = assignmentPositions.get(symbol) ?? [];
        writes.push({ position: unwrappedTarget.getStart(sourceFile), operator });
        assignmentPositions.set(symbol, writes);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(unwrappedTarget)) {
      for (const property of unwrappedTarget.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
          countAssignmentTarget(property.initializer, operator);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          countAssignmentTarget(property.name, operator);
        } else if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
          countAssignmentTarget(property.expression, operator);
        }
      }
    }
  };
  const countAssignments = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      countAssignmentTarget(node.left, node.operatorToken.kind);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      countAssignmentTarget(node.operand);
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      countAssignmentTarget(node.initializer);
    }
    ts.forEachChild(node, countAssignments);
  };
  countAssignments(sourceFile);

  const functionOwnerSymbol = (functionLike: ts.FunctionLikeDeclaration): ts.Symbol | undefined => {
    if (ts.isFunctionDeclaration(functionLike) && functionLike.name) {
      return symbolFor(functionLike.name);
    }
    if (ts.isMethodDeclaration(functionLike) && ts.isIdentifier(functionLike.name)) {
      return symbolFor(functionLike.name);
    }
    let parent: ts.Node | undefined = functionLike.parent;
    while (
      parent &&
      (ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isParenthesizedExpression(parent))
    ) {
      parent = parent.parent;
    }
    return parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
      ? symbolFor(parent.name)
      : undefined;
  };

  const calledFunctionSymbol = (expression: ts.Expression): ts.Symbol | undefined => {
    const callee = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(callee)) {
      return symbolFor(callee);
    }
    return ts.isPropertyAccessExpression(callee) ? symbolFor(callee.name) : undefined;
  };

  const eagerFunctionCallPositions = new Map<ts.Symbol, number[]>();
  const collectEagerFunctionCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.findAncestor(node, ts.isFunctionLike) === undefined) {
      const symbol = calledFunctionSymbol(node.expression);
      if (symbol) {
        const positions = eagerFunctionCallPositions.get(symbol) ?? [];
        positions.push(node.getStart(sourceFile));
        eagerFunctionCallPositions.set(symbol, positions);
      }
    }
    ts.forEachChild(node, collectEagerFunctionCalls);
  };
  collectEagerFunctionCalls(sourceFile);

  const executionPositionsFor = (node: ts.CallExpression): readonly number[] | undefined => {
    let ancestor: ts.Node | undefined = node.parent;
    while (ancestor) {
      if (ts.isFunctionLike(ancestor)) {
        const symbol = functionOwnerSymbol(ancestor);
        const positions = symbol ? eagerFunctionCallPositions.get(symbol) : undefined;
        return positions && positions.length > 0 ? positions : undefined;
      }
      ancestor = ancestor.parent;
    }
    return [node.getStart(sourceFile)];
  };

  const initializerTiming = (identifier: ts.Identifier): { startsAt: number; endsAt?: number } => {
    const symbol = symbolFor(identifier);
    const declaration = symbol?.valueDeclaration;
    const startsAt = declaration?.getEnd() ?? identifier.getEnd();
    const endsAt = symbol
      ? assignmentPositions
          .get(symbol)
          ?.find(
            (write) =>
              write.position > startsAt &&
              write.operator !== ts.SyntaxKind.BarBarEqualsToken &&
              write.operator !== ts.SyntaxKind.QuestionQuestionEqualsToken,
          )?.position
      : undefined;
    return endsAt === undefined ? { startsAt } : { startsAt, endsAt };
  };

  const assignmentTiming = (
    identifier: ts.Identifier,
    assignment: ts.BinaryExpression,
  ): { startsAt: number; endsAt?: number } => {
    const startsAt = assignment.getEnd();
    const symbol = symbolFor(identifier);
    const endsAt = symbol
      ? assignmentPositions
          .get(symbol)
          ?.find(
            (write) =>
              write.position > startsAt &&
              write.operator !== ts.SyntaxKind.BarBarEqualsToken &&
              write.operator !== ts.SyntaxKind.QuestionQuestionEqualsToken,
          )?.position
      : undefined;
    return endsAt === undefined ? { startsAt } : { startsAt, endsAt };
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

  const establishesAlias = (operator: ts.SyntaxKind): boolean =>
    operator === ts.SyntaxKind.EqualsToken ||
    operator === ts.SyntaxKind.BarBarEqualsToken ||
    operator === ts.SyntaxKind.QuestionQuestionEqualsToken;

  const registerObjectAssignment = (
    properties: readonly ts.ObjectLiteralElementLike[],
    value: ts.Expression,
    assignment: ts.BinaryExpression,
  ): void => {
    if (!isChildProcessRequire(value) && !(ts.isIdentifier(value) && hasNamespace(value))) {
      return;
    }
    const sourceExclusions = ts.isIdentifier(value) ? namespaceExclusionsFor(value) : undefined;
    const restExclusions = new Set(sourceExclusions);
    let hasDynamicExclusion = false;
    for (const property of properties) {
      if (ts.isSpreadAssignment(property)) {
        continue;
      }
      const propertyName = ts.isPropertyAssignment(property) ? property.name : undefined;
      const target = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined;
      const imported =
        staticPropertyName(propertyName, staticStringValue) ??
        (propertyName ? undefined : target && ts.isIdentifier(target) ? target.text : undefined);
      if (imported === undefined) {
        hasDynamicExclusion = true;
        continue;
      }
      if (EXECUTION_FUNCTIONS.has(imported)) {
        restExclusions.add(imported);
      }
      if (!target || !ts.isIdentifier(target) || !isUnambiguousAssignmentTarget(target)) {
        continue;
      }
      if (EXECUTION_FUNCTIONS.has(imported) && !sourceExclusions?.has(imported)) {
        addBinding(importedExecutors, target, assignmentTiming(target, assignment));
      }
    }
    if (hasDynamicExclusion) {
      return;
    }
    for (const property of properties) {
      if (
        ts.isSpreadAssignment(property) &&
        ts.isIdentifier(property.expression) &&
        isUnambiguousAssignmentTarget(property.expression)
      ) {
        addNamespace(
          property.expression,
          restExclusions,
          assignmentTiming(property.expression, assignment),
        );
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
        addNamespace(defaultBinding);
      }
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        addNamespace(bindings.name);
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
      addNamespace(node.name);
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapTransparentExpression(node.initializer);
      if (ts.isIdentifier(node.name)) {
        registerIdentifierBinding(node.name, initializer, initializerTiming(node.name));
      }
      if (ts.isObjectBindingPattern(node.name)) {
        registerObjectBinding(node.name.elements, initializer);
      }
    }

    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      const value = unwrapTransparentExpression(node.right);
      const target = unwrapTransparentExpression(node.left);
      if (
        ts.isIdentifier(target) &&
        establishesAlias(node.operatorToken.kind) &&
        isUnambiguousAssignmentTarget(target)
      ) {
        registerIdentifierBinding(target, value, assignmentTiming(target, node));
      }
      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(target)
      ) {
        registerObjectAssignment(target.properties, value, node);
      }
    }

    if (
      !collectBindingsOnly &&
      ts.isCallExpression(node) &&
      !isDiagnosticProcessTableCall(file, node)
    ) {
      const expression = unwrapTransparentExpression(node.expression);
      const executionPositions = executionPositionsFor(node);
      const direct =
        ts.isIdentifier(expression) &&
        hasBinding(importedExecutors, expression) &&
        (executionPositions === undefined ||
          executionPositions.some((position) => bindingIsAvailableAt(expression, position)));
      const namespaced =
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        ts.isIdentifier(unwrapTransparentExpression(expression.expression)) &&
        (executionPositions === undefined ||
          executionPositions.some((position) =>
            namespaceIsAvailableAt(unwrapTransparentExpression(expression.expression), position),
          )) &&
        EXECUTION_FUNCTIONS.has(staticMemberName(expression, staticStringValue) ?? "") &&
        !namespaceExclusionsFor(unwrapTransparentExpression(expression.expression))?.has(
          staticMemberName(expression, staticStringValue) ?? "",
        );
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
