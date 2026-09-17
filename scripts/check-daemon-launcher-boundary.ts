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
  const executorSources = new Map<ts.Symbol, ts.Identifier>();
  const namespaceSources = new Map<ts.Symbol, ts.Identifier>();
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
  const recordSource = (
    sources: Map<ts.Symbol, ts.Identifier>,
    identifier: ts.Identifier,
    source: ts.Identifier,
  ): void => {
    const symbol = symbolFor(identifier);
    if (symbol && !sources.has(symbol)) {
      sources.set(symbol, source);
    }
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
  // The binding pass intentionally resolves forward aliases. A source declared later can
  // still be discovered in a later pass, but a source already replaced at this point cannot.
  const bindingHasNotEndedAt = (identifier: ts.Identifier, position: number): boolean => {
    const symbol = symbolFor(identifier);
    const timing = symbol ? bindingTimings.get(symbol) : undefined;
    return timing !== undefined && (timing.endsAt === undefined || position < timing.endsAt);
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

  const namespaceHasNotEndedAt = (identifier: ts.Identifier, position: number): boolean =>
    hasNamespace(identifier) && bindingHasNotEndedAt(identifier, position);

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

  const isNamespaceExecutor = (value: ts.Expression, position: number): boolean => {
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
      namespaceHasNotEndedAt(receiver, position) &&
      executor !== undefined &&
      EXECUTION_FUNCTIONS.has(executor) &&
      !namespaceExclusionsFor(receiver)?.has(executor)
    );
  };

  const registerIdentifierBinding = (
    identifier: ts.Identifier,
    value: ts.Expression,
    timing: { startsAt: number; endsAt?: number },
    sourcePosition: number,
  ): void => {
    if (isChildProcessRequire(value)) {
      addNamespace(identifier, new Set(), timing);
    }
    if (
      ts.isIdentifier(value) &&
      hasBinding(importedExecutors, value) &&
      bindingHasNotEndedAt(value, sourcePosition)
    ) {
      addBinding(importedExecutors, identifier, timing);
      recordSource(executorSources, identifier, value);
    }
    if (ts.isIdentifier(value) && namespaceHasNotEndedAt(value, sourcePosition)) {
      addNamespace(identifier, namespaceExclusionsFor(value), timing);
      recordSource(namespaceSources, identifier, value);
    }
    if (isNamespaceExecutor(value, sourcePosition)) {
      addBinding(importedExecutors, identifier, timing);
      const memberAccess = unwrapTransparentExpression(value);
      if (
        (ts.isPropertyAccessExpression(memberAccess) ||
          ts.isElementAccessExpression(memberAccess)) &&
        ts.isIdentifier(unwrapTransparentExpression(memberAccess.expression))
      ) {
        recordSource(
          executorSources,
          identifier,
          unwrapTransparentExpression(memberAccess.expression),
        );
      }
    }
  };

  const registerObjectBinding = (
    elements: readonly ts.BindingElement[],
    value: ts.Expression,
    sourcePosition: number,
  ): void => {
    if (
      !isChildProcessRequire(value) &&
      !(ts.isIdentifier(value) && namespaceHasNotEndedAt(value, sourcePosition))
    ) {
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
        if (ts.isIdentifier(value)) {
          recordSource(executorSources, element.name, value);
        }
      }
    }
    if (hasDynamicExclusion) {
      return;
    }
    for (const element of elements) {
      if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
        addNamespace(element.name, restExclusions, initializerTiming(element.name));
        if (ts.isIdentifier(value)) {
          recordSource(namespaceSources, element.name, value);
        }
      }
    }
  };

  const assignmentCounts = new Map<ts.Symbol, number>();
  const countAssignmentTarget = (
    target: ts.Expression,
    position: number,
    operator?: ts.SyntaxKind,
  ): void => {
    const unwrappedTarget = unwrapTransparentExpression(target);
    if (ts.isIdentifier(unwrappedTarget)) {
      const symbol = symbolFor(unwrappedTarget);
      if (symbol) {
        assignmentCounts.set(symbol, (assignmentCounts.get(symbol) ?? 0) + 1);
        const writes = assignmentPositions.get(symbol) ?? [];
        writes.push({ position, operator });
        assignmentPositions.set(symbol, writes);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(unwrappedTarget)) {
      for (const property of unwrappedTarget.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
          countAssignmentTarget(property.initializer, position, operator);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          countAssignmentTarget(property.name, position, operator);
        } else if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
          countAssignmentTarget(property.expression, position, operator);
        }
      }
    }
  };
  const countAssignments = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      countAssignmentTarget(node.left, node.getEnd(), node.operatorToken.kind);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      countAssignmentTarget(node.operand, node.getEnd());
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      countAssignmentTarget(node.initializer, node.getEnd());
    }
    ts.forEachChild(node, countAssignments);
  };
  countAssignments(sourceFile);

  const functionOwnerDeclaration = (
    functionLike: ts.FunctionLikeDeclaration,
  ): ts.Node | undefined => {
    if (ts.isFunctionDeclaration(functionLike) || ts.isMethodDeclaration(functionLike)) {
      return functionLike;
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
      ? parent
      : undefined;
  };

  const hasModifier = (node: ts.Node, modifier: ts.SyntaxKind): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some(({ kind }) => kind === modifier) ?? false);

  const ownerIsExported = (owner: ts.Node): boolean => {
    if (hasModifier(owner, ts.SyntaxKind.ExportKeyword)) {
      return true;
    }
    let ancestor: ts.Node | undefined = owner.parent;
    while (ancestor) {
      if (hasModifier(ancestor, ts.SyntaxKind.ExportKeyword)) {
        return true;
      }
      if (ts.isSourceFile(ancestor) || ts.isFunctionLike(ancestor)) {
        return false;
      }
      if (ts.isClassDeclaration(ancestor) || ts.isClassExpression(ancestor)) {
        return hasModifier(ancestor, ts.SyntaxKind.ExportKeyword);
      }
      ancestor = ancestor.parent;
    }
    return false;
  };

  const functionMaySuspend = (functionLike: ts.FunctionLikeDeclaration): boolean =>
    hasModifier(functionLike, ts.SyntaxKind.AsyncKeyword) ||
    ("asteriskToken" in functionLike && functionLike.asteriskToken !== undefined);

  const calledFunctionDeclaration = (expression: ts.Expression): ts.Node | undefined => {
    const callee = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(callee)) {
      return symbolFor(callee)?.valueDeclaration;
    }
    return ts.isPropertyAccessExpression(callee)
      ? symbolFor(callee.name)?.valueDeclaration
      : undefined;
  };

  const functionOwners = new Set<ts.Node>();
  const collectFunctionOwners = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      const owner = functionOwnerDeclaration(node);
      if (owner) {
        functionOwners.add(owner);
      }
    }
    ts.forEachChild(node, collectFunctionOwners);
  };
  collectFunctionOwners(sourceFile);

  const eagerFunctionCallPositions = new Map<ts.Node, number[]>();
  const collectEagerFunctionCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.findAncestor(node, ts.isFunctionLike) === undefined) {
      const declaration = calledFunctionDeclaration(node.expression);
      if (declaration) {
        const positions = eagerFunctionCallPositions.get(declaration) ?? [];
        positions.push(node.getStart(sourceFile));
        eagerFunctionCallPositions.set(declaration, positions);
      }
    }
    ts.forEachChild(node, collectEagerFunctionCalls);
  };
  collectEagerFunctionCalls(sourceFile);

  const isOwnerDeclarationName = (identifier: ts.Identifier, owner: ts.Node): boolean =>
    (ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner)) && owner.name === identifier
      ? true
      : ts.isVariableDeclaration(owner) && owner.name === identifier;

  const isDirectEagerOwnerCall = (identifier: ts.Identifier, owner: ts.Node): boolean => {
    let callee: ts.Expression = identifier;
    while (
      callee.parent &&
      (ts.isAsExpression(callee.parent) ||
        ts.isTypeAssertionExpression(callee.parent) ||
        ts.isNonNullExpression(callee.parent) ||
        ts.isSatisfiesExpression(callee.parent) ||
        ts.isParenthesizedExpression(callee.parent))
    ) {
      callee = callee.parent;
    }
    if (ts.isPropertyAccessExpression(callee.parent) && callee.parent.name === callee) {
      callee = callee.parent;
    }
    return (
      ts.isCallExpression(callee.parent) &&
      callee.parent.expression === callee &&
      ts.findAncestor(callee.parent, ts.isFunctionLike) === undefined &&
      calledFunctionDeclaration(callee) === owner
    );
  };

  const escapedFunctionOwners = new Set<ts.Node>();
  const collectFunctionEscapes = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const owner = symbolFor(node)?.valueDeclaration;
      if (
        owner &&
        functionOwners.has(owner) &&
        !isOwnerDeclarationName(node, owner) &&
        !isDirectEagerOwnerCall(node, owner)
      ) {
        escapedFunctionOwners.add(owner);
      }
    }
    ts.forEachChild(node, collectFunctionEscapes);
  };
  collectFunctionEscapes(sourceFile);

  const executionPositionsFor = (node: ts.CallExpression): readonly number[] | undefined => {
    let ancestor: ts.Node | undefined = node.parent;
    while (ancestor) {
      if (ts.isFunctionLike(ancestor)) {
        const declaration = functionOwnerDeclaration(ancestor);
        const positions = declaration ? eagerFunctionCallPositions.get(declaration) : undefined;
        return declaration &&
          !ownerIsExported(declaration) &&
          !escapedFunctionOwners.has(declaration) &&
          !functionMaySuspend(ancestor) &&
          positions &&
          positions.length > 0
          ? positions
          : undefined;
      }
      if (
        ts.isPropertyDeclaration(ancestor) &&
        !hasModifier(ancestor, ts.SyntaxKind.StaticKeyword)
      ) {
        return undefined;
      }
      ancestor = ancestor.parent;
    }
    return [node.getStart(sourceFile)];
  };

  const functionOwnerForNode = (node: ts.Node): ts.Node | undefined => {
    const functionLike = ts.findAncestor(node, ts.isFunctionLike);
    return functionLike ? functionOwnerDeclaration(functionLike) : undefined;
  };

  const bindingIsAvailableForExecution = (
    identifier: ts.Identifier,
    call: ts.CallExpression,
    positions: readonly number[],
    sources: ReadonlyMap<ts.Symbol, ts.Identifier>,
    seen: ReadonlySet<ts.Symbol> = new Set(),
  ): boolean => {
    const symbol = symbolFor(identifier);
    if (!symbol || seen.has(symbol)) {
      return false;
    }
    const bindingOwner = symbol.valueDeclaration
      ? functionOwnerForNode(symbol.valueDeclaration)
      : undefined;
    const callOwner = functionOwnerForNode(call);
    if (bindingOwner && bindingOwner === callOwner) {
      const timing = bindingTimings.get(symbol);
      if (timing?.endsAt !== undefined && call.getStart(sourceFile) >= timing.endsAt) {
        return false;
      }
      const source = sources.get(symbol);
      if (!source) {
        return true;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      return sourceIsAvailableForExecution(source, call, positions, nextSeen);
    }
    return positions.some((position) => bindingIsAvailableAt(identifier, position));
  };

  const sourceIsAvailableForExecution = (
    identifier: ts.Identifier,
    call: ts.CallExpression,
    positions: readonly number[],
    seen: ReadonlySet<ts.Symbol>,
  ): boolean => {
    if (hasBinding(importedExecutors, identifier)) {
      return bindingIsAvailableForExecution(identifier, call, positions, executorSources, seen);
    }
    return (
      hasNamespace(identifier) &&
      bindingIsAvailableForExecution(identifier, call, positions, namespaceSources, seen)
    );
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

  const assignmentPatternTarget = (
    target: ts.Expression | undefined,
  ): ts.Identifier | undefined => {
    const value = target ? unwrapTransparentExpression(target) : undefined;
    if (value && ts.isIdentifier(value)) {
      return value;
    }
    return value &&
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapTransparentExpression(value.left))
      ? unwrapTransparentExpression(value.left)
      : undefined;
  };

  const registerObjectAssignment = (
    properties: readonly ts.ObjectLiteralElementLike[],
    value: ts.Expression,
    assignment: ts.BinaryExpression,
  ): void => {
    const sourcePosition = assignment.right.getStart(sourceFile);
    if (
      !isChildProcessRequire(value) &&
      !(ts.isIdentifier(value) && namespaceHasNotEndedAt(value, sourcePosition))
    ) {
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
      const targetIdentifier = assignmentPatternTarget(target);
      if (!targetIdentifier || !isUnambiguousAssignmentTarget(targetIdentifier)) {
        continue;
      }
      if (EXECUTION_FUNCTIONS.has(imported) && !sourceExclusions?.has(imported)) {
        addBinding(
          importedExecutors,
          targetIdentifier,
          assignmentTiming(targetIdentifier, assignment),
        );
        if (ts.isIdentifier(value)) {
          recordSource(executorSources, targetIdentifier, value);
        }
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
        if (ts.isIdentifier(value)) {
          recordSource(namespaceSources, property.expression, value);
        }
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
        registerIdentifierBinding(
          node.name,
          initializer,
          initializerTiming(node.name),
          node.initializer.getStart(sourceFile),
        );
      }
      if (ts.isObjectBindingPattern(node.name)) {
        registerObjectBinding(
          node.name.elements,
          initializer,
          node.initializer.getStart(sourceFile),
        );
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
        registerIdentifierBinding(
          target,
          value,
          assignmentTiming(target, node),
          node.right.getStart(sourceFile),
        );
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
      const namespaceReceiver =
        ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
          ? unwrapTransparentExpression(expression.expression)
          : undefined;
      const direct =
        ts.isIdentifier(expression) &&
        hasBinding(importedExecutors, expression) &&
        (executionPositions === undefined ||
          bindingIsAvailableForExecution(expression, node, executionPositions, executorSources));
      const hasNamespaceReceiver =
        namespaceReceiver !== undefined &&
        (ts.isIdentifier(namespaceReceiver)
          ? hasNamespace(namespaceReceiver)
          : isChildProcessRequire(namespaceReceiver));
      const namespaced =
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        hasNamespaceReceiver &&
        (executionPositions === undefined ||
          (ts.isIdentifier(namespaceReceiver)
            ? bindingIsAvailableForExecution(
                namespaceReceiver,
                node,
                executionPositions,
                namespaceSources,
              )
            : isChildProcessRequire(namespaceReceiver))) &&
        EXECUTION_FUNCTIONS.has(staticMemberName(expression, staticStringValue) ?? "") &&
        !(
          ts.isIdentifier(namespaceReceiver) &&
          namespaceExclusionsFor(namespaceReceiver)?.has(
            staticMemberName(expression, staticStringValue) ?? "",
          )
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
