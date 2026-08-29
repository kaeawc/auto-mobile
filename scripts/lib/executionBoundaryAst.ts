import ts from "typescript";

export const PROCESS_LAUNCHERS = new Set([
  "spawn",
  "spawnSync",
  "spawnCommand",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "execFileAsync",
]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const INJECTED_LAUNCHERS = new Set(["spawn", "spawnSync"]);
export const DYNAMIC_BOUNDARY = "\u0000";
export const STRING_ANALYSIS_OVERFLOW = "\u0003";
const MAX_STRING_ALTERNATIVES = 256;

export interface ExecutionBoundaryAst {
  readonly calls: readonly ts.CallExpression[];
  calleeName(call: ts.CallExpression): string | undefined;
  isLauncher(call: ts.CallExpression): boolean;
  isExecutionSeam(call: ts.CallExpression): boolean;
  isRunExecSeam(call: ts.CallExpression): boolean;
  strings(node: ts.Expression | undefined): string[];
  stringAlternatives(node: ts.Expression | undefined): string[];
  arrayAlternatives(node: ts.Expression | undefined): ts.Expression[][] | undefined;
  arrayElements(node: ts.Expression | undefined): ts.Expression[] | undefined;
  objectPropertyValues(node: ts.Expression | undefined, propertyName: string): ts.Expression[];
  containsCallNamed(node: ts.Expression | undefined, names: ReadonlySet<string>): boolean;
}

function propertyName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function propertyNameOf(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingIdentifiers(element.name) : [],
  );
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

/**
 * Parses one TypeScript source file and provides conservative, scope-insensitive value flow for
 * execution-boundary guards. A value bound anywhere to a bare name is considered at every use:
 * that can produce a loud false-positive, but cannot silently let an alias or injected seam hide
 * a prohibited launcher call.
 */
export function executionBoundaryAst(source: string): ExecutionBoundaryAst {
  const sourceFile = ts.createSourceFile(
    "execution-boundary.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const initializers = new Map<string, ts.Expression[]>();
  const scopedValues: Array<{
    kind: "assignment" | "declaration";
    name: string;
    value: ts.Expression;
    scope: ts.Node;
    position: number;
  }> = [];
  type DeclarationBinding = { name: string; scope: ts.Node; position: number };
  const declarations: DeclarationBinding[] = [];
  const functionBindings: Array<{
    name: string;
    node: ts.FunctionLikeDeclaration;
    scope: ts.Node;
    position: number;
    receiverDeclaration?: DeclarationBinding;
  }> = [];
  const classInstanceMethods: Array<{
    classDeclaration: DeclarationBinding;
    name: string;
    node: ts.MethodDeclaration;
    scope: ts.Node;
    position: number;
  }> = [];
  type InvocationExpression = ts.CallExpression | ts.NewExpression;
  const calls: ts.CallExpression[] = [];
  const invocations: InvocationExpression[] = [];
  const launcherAliases = new Set(PROCESS_LAUNCHERS);
  const executionSeamAliases = new Set(["executeCommand", "runExecSeam", "execute"]);
  const runExecSeamAliases = new Set(["runExecSeam"]);
  const childProcessNamespaces = new Set<string>();
  const functionName = (node: ts.FunctionLikeDeclaration): string | undefined => {
    if (
      ts.isConstructorDeclaration(node) &&
      ts.isClassDeclaration(node.parent) &&
      node.parent.name
    ) {
      return node.parent.name.text;
    }
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    if (ts.isPropertyAssignment(node.parent)) {
      const assignedName = propertyNameOf(node.parent.name);
      if (assignedName) {
        return assignedName;
      }
    }
    if (node.name && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    return undefined;
  };
  const lexicalScope = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isModuleBlock(current) ||
        ts.isCaseBlock(current) ||
        ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current)
      ) {
        return current;
      }
      current = current.parent;
    }
    return sourceFile;
  };
  const functionScope = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionLike(current)) {
        return current;
      }
      if (ts.isModuleBlock(current)) {
        return current;
      }
      if (ts.isSourceFile(current)) {
        return current;
      }
      current = current.parent;
    }
    return sourceFile;
  };
  const variableDeclarationScope = (node: ts.VariableDeclaration): ts.Node =>
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0
      ? lexicalScope(node)
      : functionScope(node);
  const scopeChainCache = new Map<ts.Node, ts.Node[]>();
  const scopeChain = (node: ts.Node): ts.Node[] => {
    const cached = scopeChainCache.get(node);
    if (cached) {
      return cached;
    }
    const scopes: ts.Node[] = [];
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isModuleBlock(current) ||
        ts.isCaseBlock(current) ||
        ts.isFunctionLike(current) ||
        ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current)
      ) {
        scopes.push(current);
      }
      current = current.parent;
    }
    scopeChainCache.set(node, scopes);
    return scopes;
  };
  const bind = (
    name: string,
    value: ts.Expression,
    owner: ts.Node,
    kind: "assignment" | "declaration",
  ): void => {
    initializers.set(name, [...(initializers.get(name) ?? []), value]);
    scopedValues.push({
      name,
      value,
      kind,
      scope: lexicalScope(owner),
      position: owner.getStart(sourceFile),
    });
  };
  const collect = (node: ts.Node): void => {
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
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (PROCESS_LAUNCHERS.has(imported)) {
            launcherAliases.add(element.name.text);
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
    if (ts.isVariableDeclaration(node)) {
      const scope = variableDeclarationScope(node);
      const variableDeclarations = bindingIdentifiers(node.name).map((identifier) => ({
        name: identifier.text,
        scope,
        position: node.getStart(sourceFile),
      }));
      declarations.push(...variableDeclarations);
      const receiverDeclaration = ts.isIdentifier(node.name)
        ? variableDeclarations.find((declaration) => declaration.name === node.name.text)
        : undefined;
      if (ts.isIdentifier(node.name) && node.initializer && ts.isFunctionLike(node.initializer)) {
        functionBindings.push({
          name: node.name.text,
          node: node.initializer,
          scope,
          position: node.getStart(sourceFile),
        });
      }
      if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties) {
          const method = ts.isMethodDeclaration(property)
            ? property
            : ts.isPropertyAssignment(property) && ts.isFunctionLike(property.initializer)
              ? property.initializer
              : undefined;
          const methodName =
            ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)
              ? propertyNameOf(property.name)
              : undefined;
          if (method && methodName) {
            functionBindings.push({
              name: methodName,
              node: method,
              scope,
              position: node.getStart(sourceFile),
              receiverDeclaration,
            });
          }
        }
      }
      if (ts.isIdentifier(node.name)) {
        if (node.initializer) {
          initializers.set(node.name.text, [
            ...(initializers.get(node.name.text) ?? []),
            node.initializer,
          ]);
          scopedValues.push({
            name: node.name.text,
            value: node.initializer,
            kind: "declaration",
            scope,
            position: node.getStart(sourceFile),
          });
        }
      }
      if (ts.isObjectBindingPattern(node.name)) {
        const initializer = node.initializer;
        const fromChildProcess =
          initializer &&
          ((ts.isIdentifier(initializer) && childProcessNamespaces.has(initializer.text)) ||
            (ts.isCallExpression(initializer) &&
              ts.isIdentifier(initializer.expression) &&
              initializer.expression.text === "require" &&
              initializer.arguments.length === 1 &&
              ts.isStringLiteral(initializer.arguments[0]) &&
              CHILD_PROCESS_MODULES.has(initializer.arguments[0].text)));
        for (const element of node.name.elements) {
          const property =
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : ts.isIdentifier(element.name)
                ? element.name.text
                : undefined;
          if (
            fromChildProcess &&
            property &&
            ts.isIdentifier(element.name) &&
            PROCESS_LAUNCHERS.has(property)
          ) {
            launcherAliases.add(element.name.text);
          }
        }
      }
      if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "require" &&
        node.initializer.arguments.length === 1 &&
        ts.isStringLiteral(node.initializer.arguments[0]) &&
        CHILD_PROCESS_MODULES.has(node.initializer.arguments[0].text)
      ) {
        childProcessNamespaces.add(node.name.text);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionBindings.push({
        name: node.name.text,
        node,
        scope: lexicalScope(node),
        position: node.getStart(sourceFile),
      });
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const scope = lexicalScope(node);
      const receiverDeclaration: DeclarationBinding = {
        name: node.name.text,
        scope,
        position: node.getStart(sourceFile),
      };
      declarations.push(receiverDeclaration);
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          functionBindings.push({
            name: node.name.text,
            node: member,
            scope,
            position: member.getStart(sourceFile),
          });
        }
        if (
          ts.isMethodDeclaration(member) &&
          member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
        ) {
          const methodName = propertyNameOf(member.name);
          if (methodName) {
            functionBindings.push({
              name: methodName,
              node: member,
              scope,
              position: member.getStart(sourceFile),
              receiverDeclaration,
            });
          }
        } else if (ts.isMethodDeclaration(member)) {
          const methodName = propertyNameOf(member.name);
          if (methodName) {
            classInstanceMethods.push({
              classDeclaration: receiverDeclaration,
              name: methodName,
              node: member,
              scope,
              position: member.getStart(sourceFile),
            });
          }
        }
      }
    }
    if (ts.isParameter(node)) {
      const scope = functionScope(node);
      for (const identifier of bindingIdentifiers(node.name)) {
        declarations.push({ name: identifier.text, scope, position: node.getStart(sourceFile) });
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const identifier of bindingIdentifiers(node.variableDeclaration.name)) {
        declarations.push({
          name: identifier.text,
          scope: node.block,
          position: node.variableDeclaration.getStart(sourceFile),
        });
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      bind(node.left.text, node.right, node, "assignment");
      if (ts.isFunctionLike(node.right)) {
        functionBindings.push({
          name: node.left.text,
          node: node.right,
          scope: lexicalScope(node),
          position: node.getStart(sourceFile),
        });
      }
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
      invocations.push(node);
    } else if (ts.isNewExpression(node)) {
      invocations.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  for (const binding of scopedValues) {
    const value = unwrapTransparentExpression(binding.value);
    if (
      binding.kind !== "declaration" ||
      !ts.isNewExpression(value) ||
      !ts.isIdentifier(value.expression)
    ) {
      continue;
    }
    const receiverDeclaration = declarations.find(
      (declaration) =>
        declaration.name === binding.name &&
        declaration.scope === binding.scope &&
        declaration.position === binding.position,
    );
    if (!receiverDeclaration) {
      continue;
    }
    // A later assignment can replace the instance with an unrelated subclass.
    // Do not associate that mutable receiver with its declaration initializer.
    if (
      scopedValues.some(
        (candidate) =>
          candidate.kind === "assignment" &&
          candidate.name === binding.name &&
          candidate.position > binding.position,
      )
    ) {
      continue;
    }
    const constructorScopes = scopeChain(value.expression);
    const classDeclaration = declarations
      .filter(
        (declaration) =>
          declaration.name === value.expression.text &&
          constructorScopes.includes(declaration.scope) &&
          declaration.position <= value.expression.getStart(sourceFile) &&
          classInstanceMethods.some((method) => method.classDeclaration === declaration),
      )
      .sort((left, right) => {
        const scopeDelta =
          constructorScopes.indexOf(left.scope) - constructorScopes.indexOf(right.scope);
        return scopeDelta !== 0 ? scopeDelta : right.position - left.position;
      })[0];
    if (!classDeclaration) {
      continue;
    }
    for (const method of classInstanceMethods) {
      if (method.classDeclaration === classDeclaration) {
        functionBindings.push({
          name: method.name,
          node: method.node,
          scope: binding.scope,
          position: binding.position,
          receiverDeclaration,
        });
      }
    }
  }

  const receiverDeclarationCache = new Map<ts.Identifier, DeclarationBinding | null>();
  const resolveReceiverDeclaration = (
    receiver: ts.Identifier,
    callScopes: readonly ts.Node[],
  ): DeclarationBinding | undefined => {
    const cached = receiverDeclarationCache.get(receiver);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const usePosition = receiver.getStart(sourceFile);
    for (const scope of callScopes) {
      let nearest: DeclarationBinding | undefined;
      for (const declaration of declarations) {
        if (
          declaration.name === receiver.text &&
          declaration.scope === scope &&
          declaration.position <= usePosition &&
          (!nearest || declaration.position > nearest.position)
        ) {
          nearest = declaration;
        }
      }
      if (nearest) {
        receiverDeclarationCache.set(receiver, nearest);
        return nearest;
      }
    }
    receiverDeclarationCache.set(receiver, null);
    return undefined;
  };
  const identifierResolvesToFunction = (
    name: string,
    target: ts.FunctionLikeDeclaration,
    callScopes: readonly ts.Node[],
    beforePosition: number,
    seen = new Set<string>(),
  ): boolean => {
    if (seen.has(name)) {
      return false;
    }
    const nextSeen = new Set([...seen, name]);
    const definitions: Array<
      | { kind: "function"; node: ts.FunctionLikeDeclaration; scope: ts.Node; position: number }
      | { kind: "value"; value: ts.Expression; scope: ts.Node; position: number }
    > = [
      ...functionBindings
        .filter(
          (binding) =>
            binding.name === name &&
            binding.receiverDeclaration === undefined &&
            callScopes.includes(binding.scope) &&
            (ts.isFunctionDeclaration(binding.node) || binding.position < beforePosition),
        )
        .map((binding) => ({
          kind: "function" as const,
          node: binding.node,
          scope: binding.scope,
          position:
            ts.isFunctionDeclaration(binding.node) && binding.position >= beforePosition
              ? -1
              : binding.position,
        })),
      ...scopedValues
        .filter(
          (binding) =>
            binding.name === name &&
            callScopes.includes(binding.scope) &&
            binding.position < beforePosition,
        )
        .map((binding) => ({
          kind: "value" as const,
          value: binding.value,
          scope: binding.scope,
          position: binding.position,
        })),
    ].sort((left, right) => {
      const scopeDelta = callScopes.indexOf(left.scope) - callScopes.indexOf(right.scope);
      if (scopeDelta !== 0) {
        return scopeDelta;
      }
      const positionDelta = right.position - left.position;
      if (positionDelta !== 0) {
        return positionDelta;
      }
      return left.kind === "function" ? -1 : 1;
    });
    const definition = definitions[0];
    if (!definition) {
      return false;
    }
    if (definition.kind === "function") {
      return definition.node === target;
    }
    const value = unwrapTransparentExpression(definition.value);
    if (value === target) {
      return true;
    }
    return ts.isIdentifier(value)
      ? identifierResolvesToFunction(value.text, target, callScopes, definition.position, nextSeen)
      : false;
  };

  const callResolutionCache = new Map<
    InvocationExpression,
    Map<ts.FunctionLikeDeclaration, boolean>
  >();

  const callResolvesToFunction = (
    call: InvocationExpression,
    target: ts.FunctionLikeDeclaration,
  ): boolean => {
    const cached = callResolutionCache.get(call)?.get(target);
    if (cached !== undefined) {
      return cached;
    }
    const finish = (result: boolean): boolean => {
      const resolutions = callResolutionCache.get(call) ?? new Map();
      resolutions.set(target, result);
      callResolutionCache.set(call, resolutions);
      return result;
    };
    if (target.asteriskToken) {
      return finish(false);
    }
    if (unwrapTransparentExpression(call.expression) === target) {
      return finish(true);
    }
    const callee = unwrapTransparentExpression(call.expression);
    const receiver =
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      ts.isIdentifier(callee.expression)
        ? callee.expression
        : undefined;
    if (!ts.isIdentifier(callee) && receiver === undefined) {
      return finish(false);
    }
    const callScopes = scopeChain(call);
    if (receiver === undefined && ts.isIdentifier(callee)) {
      return finish(
        identifierResolvesToFunction(callee.text, target, callScopes, call.getStart(sourceFile)),
      );
    }
    const name = functionName(target);
    if (!name) {
      return finish(false);
    }
    if (receiver !== undefined && propertyName(callee) !== name) {
      return finish(false);
    }
    const receiverDeclaration = receiver
      ? resolveReceiverDeclaration(receiver, callScopes)
      : undefined;
    const candidates = functionBindings
      .filter(
        (binding) =>
          binding.name === name &&
          (receiver === undefined
            ? binding.receiverDeclaration === undefined
            : binding.receiverDeclaration === receiverDeclaration) &&
          callScopes.includes(binding.scope) &&
          (ts.isFunctionDeclaration(binding.node) || binding.position < call.getStart(sourceFile)),
      )
      .sort((left, right) => {
        const scopeDelta = callScopes.indexOf(left.scope) - callScopes.indexOf(right.scope);
        return scopeDelta !== 0 ? scopeDelta : right.position - left.position;
      });
    return finish(candidates[0]?.node === target);
  };

  const callExecutionCache = new Map<InvocationExpression, Map<number, boolean>>();

  const statementDefinitelyAwaits = (statement: ts.Statement): boolean => {
    if (ts.isExpressionStatement(statement)) {
      return ts.isAwaitExpression(unwrapTransparentExpression(statement.expression));
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) =>
          declaration.initializer !== undefined &&
          ts.isAwaitExpression(unwrapTransparentExpression(declaration.initializer)),
      );
    }
    return false;
  };

  const assignmentRequiresCompletedAsyncCall = (
    assignment: ts.Expression,
    owner: ts.FunctionLikeDeclaration,
  ): boolean => {
    if (!owner.body || !ts.isBlock(owner.body)) {
      return false;
    }
    let containingStatement: ts.Statement | undefined;
    let current: ts.Node | undefined = assignment;
    while (current && current.parent !== owner.body) {
      current = current.parent;
    }
    if (current && ts.isStatement(current)) {
      containingStatement = current;
    }
    if (!containingStatement) {
      return false;
    }
    for (const statement of owner.body.statements) {
      if (statement === containingStatement) {
        return false;
      }
      // Only a direct, unconditional top-level await is enough evidence that an
      // unawaited invocation has suspended. Conditional/nested awaits stay
      // conservative so the boundary check cannot silently miss a launcher.
      if (statementDefinitelyAwaits(statement)) {
        return true;
      }
    }
    return false;
  };

  const invocationIsAwaited = (invocation: InvocationExpression): boolean => {
    let current: ts.Node = invocation;
    while (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)
    ) {
      current = current.parent;
    }
    if (ts.isArrayLiteralExpression(current.parent)) {
      const array = current.parent;
      const combinator = array.parent;
      if (
        ts.isCallExpression(combinator) &&
        combinator.arguments.includes(array) &&
        (ts.isPropertyAccessExpression(combinator.expression) ||
          ts.isElementAccessExpression(combinator.expression)) &&
        ts.isIdentifier(combinator.expression.expression) &&
        combinator.expression.expression.text === "Promise" &&
        propertyName(combinator.expression) === "all"
      ) {
        current = combinator;
      }
    }
    return ts.isAwaitExpression(current.parent);
  };

  const callCanExecuteBefore = (
    call: InvocationExpression,
    beforePosition: number,
    seenFunctions = new Set<ts.FunctionLikeDeclaration>(),
  ): boolean => {
    const cached =
      seenFunctions.size === 0 ? callExecutionCache.get(call)?.get(beforePosition) : undefined;
    if (cached !== undefined) {
      return cached;
    }
    let current: ts.Node | undefined = call.parent;
    while (current && !ts.isFunctionLike(current)) {
      current = current.parent;
    }
    if (!current || !ts.isFunctionLike(current)) {
      if (seenFunctions.size === 0) {
        const positions = callExecutionCache.get(call) ?? new Map();
        positions.set(beforePosition, true);
        callExecutionCache.set(call, positions);
      }
      return true;
    }
    if (seenFunctions.has(current)) {
      return false;
    }
    const nextSeen = new Set([...seenFunctions, current]);
    const executable = invocations.some(
      (invocation) =>
        invocation.getStart(sourceFile) < beforePosition &&
        callResolvesToFunction(invocation, current) &&
        callCanExecuteBefore(invocation, beforePosition, nextSeen),
    );
    if (seenFunctions.size === 0) {
      const positions = callExecutionCache.get(call) ?? new Map();
      positions.set(beforePosition, executable);
      callExecutionCache.set(call, positions);
    }
    return executable;
  };

  const isPromisifiedLauncher = (node: ts.Expression): boolean =>
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    propertyName(node.expression) === "promisify" &&
    isLauncherReference(node.arguments[0]);
  const isLauncherReference = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && launcherAliases.has(node.text)) ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      PROCESS_LAUNCHERS.has(propertyName(node) ?? "") &&
      ts.isIdentifier(node.expression) &&
      childProcessNamespaces.has(node.expression.text)) ||
    isPromisifiedLauncher(node);
  const isRegExpReference = (node: ts.Expression, seen = new Set<string>()): boolean => {
    node = unwrapTransparentExpression(node);
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      return true;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp"
    ) {
      return true;
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const scopes = scopeChain(node);
      const usePosition = node.getStart(sourceFile);
      let binding: (typeof scopedValues)[number] | undefined;
      for (const scope of scopes) {
        const candidates = scopedValues.flatMap((candidate) => {
          let candidateScope = candidate.scope;
          if (candidate.kind === "assignment") {
            const assignmentScopes = scopeChain(candidate.value);
            const declaration = assignmentScopes
              .map((assignmentScope) =>
                declarations.find(
                  (item) => item.name === candidate.name && item.scope === assignmentScope,
                ),
              )
              .find((item) => item !== undefined);
            candidateScope = declaration?.scope ?? candidateScope;
          }
          const useFunctions: ts.FunctionLikeDeclaration[] = [];
          let current: ts.Node | undefined = node.parent;
          while (current && current !== candidateScope) {
            if (ts.isFunctionLike(current)) {
              useFunctions.push(current);
            }
            current = current.parent;
          }
          const useFunction = useFunctions.at(-1);
          const useFunctionName = useFunction ? functionName(useFunction) : undefined;
          const useInvocationPositions = useFunctionName
            ? invocations
                .filter(
                  (call) =>
                    callResolvesToFunction(call, useFunction!) &&
                    callCanExecuteBefore(call, Number.POSITIVE_INFINITY),
                )
                .map((call) => call.getStart(sourceFile))
            : [];
          const useExecutionPosition =
            useInvocationPositions.length > 0 ? Math.max(...useInvocationPositions) : usePosition;

          const candidateFunctions: ts.FunctionLikeDeclaration[] = [];
          current = candidate.value.parent;
          while (current && current !== candidateScope) {
            if (ts.isFunctionLike(current)) {
              candidateFunctions.push(current);
            }
            current = current.parent;
          }
          const candidateFunction = candidateFunctions.at(-1);
          const candidateFunctionName = candidateFunction
            ? functionName(candidateFunction)
            : undefined;
          const candidateInvocationPositions = candidateFunctionName
            ? invocations
                .filter(
                  (call) =>
                    callResolvesToFunction(call, candidateFunction!) &&
                    callCanExecuteBefore(call, useExecutionPosition) &&
                    (!assignmentRequiresCompletedAsyncCall(candidate.value, candidateFunction!) ||
                      invocationIsAwaited(call)) &&
                    (call.getStart(sourceFile) < useExecutionPosition ||
                      (candidateFunction === useFunction &&
                        useInvocationPositions.includes(call.getStart(sourceFile)))),
                )
                .map((call) => call.getStart(sourceFile))
            : invocations
                .filter(
                  (call) =>
                    unwrapTransparentExpression(call.expression) === candidateFunction &&
                    call.getStart(sourceFile) < useExecutionPosition,
                )
                .map((call) => call.getStart(sourceFile));
          if (candidateFunction && candidateInvocationPositions.length === 0) {
            return [];
          }
          const effectivePosition =
            candidateInvocationPositions.length > 0
              ? Math.max(...candidateInvocationPositions)
              : candidate.position;
          const earlierInSameInvocation =
            candidateFunction === useFunction &&
            candidate.position < usePosition &&
            candidateInvocationPositions.some((position) =>
              useInvocationPositions.includes(position),
            );
          return candidate.name === node.text &&
            candidateScope === scope &&
            (effectivePosition < useExecutionPosition || earlierInSameInvocation)
            ? [{ candidate, effectivePosition, earlierInSameInvocation }]
            : [];
        });
        binding = candidates.sort(
          (left, right) =>
            right.effectivePosition - left.effectivePosition ||
            Number(right.earlierInSameInvocation) - Number(left.earlierInSameInvocation) ||
            right.candidate.position - left.candidate.position,
        )[0]?.candidate;
        if (binding) {
          break;
        }
      }
      return binding ? isRegExpReference(binding.value, new Set([...seen, node.text])) : false;
    }
    return false;
  };
  const isExecutionSeamReference = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && executionSeamAliases.has(node.text)) ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ((propertyName(node) === "exec" && !isRegExpReference(node.expression)) ||
        propertyName(node) === "execSync" ||
        propertyName(node) === "executeCommand" ||
        propertyName(node) === "runExecSeam" ||
        (propertyName(node) === "execute" &&
          (node.expression.kind === ts.SyntaxKind.ThisKeyword ||
            /(?:executor|host|process|deps)/i.test(node.expression.getText(sourceFile))))));
  const isRunExecSeamReference = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && runExecSeamAliases.has(node.text)) ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      propertyName(node) === "runExecSeam");
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, values] of initializers) {
      if (!launcherAliases.has(name) && values.some(isLauncherReference)) {
        launcherAliases.add(name);
        changed = true;
      }
      if (!executionSeamAliases.has(name) && values.some(isExecutionSeamReference)) {
        executionSeamAliases.add(name);
        changed = true;
      }
      if (!runExecSeamAliases.has(name) && values.some(isRunExecSeamReference)) {
        runExecSeamAliases.add(name);
        changed = true;
      }
    }
  }

  const strings = (node: ts.Expression | undefined, seen = new Set<string>()): string[] => {
    if (!node) {
      return [];
    }
    node = unwrapTransparentExpression(node);
    if (ts.isStringLiteralLike(node)) {
      return [node.text];
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return [node.text];
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isPropertyAccessExpression(node.tag) &&
      ts.isIdentifier(node.tag.expression) &&
      node.tag.expression.text === "String" &&
      node.tag.name.text === "raw"
    ) {
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        return [node.template.rawText ?? node.template.text];
      }
      return strings(node.template, seen);
    }
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) {
        const interpolation = strings(span.expression, seen);
        if (
          interpolation.length > 0 &&
          interpolation.every((value) => !value.includes(DYNAMIC_BOUNDARY))
        ) {
          values = values.flatMap((prefix) =>
            interpolation.map((value) => prefix + value + span.literal.text),
          );
        } else {
          values = [...values, DYNAMIC_BOUNDARY, span.literal.text];
        }
      }
      return values;
    }
    if (ts.isConditionalExpression(node)) {
      return [...strings(node.whenTrue, seen), ...strings(node.whenFalse, seen)];
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    ) {
      return [...strings(node.left, seen), ...strings(node.right, seen)];
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = strings(node.left, seen);
      const right = strings(node.right, seen);
      const staticLeft = left.length === 1 && !left[0].includes(DYNAMIC_BOUNDARY);
      const staticRight = right.length === 1 && !right[0].includes(DYNAMIC_BOUNDARY);
      if (staticLeft && staticRight) {
        return [left[0] + right[0]];
      }
      return [...left, DYNAMIC_BOUNDARY, ...right];
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((element) =>
        ts.isExpression(element) ? strings(element, seen) : [],
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) ? strings(property.initializer, seen) : [],
      );
    }
    if (ts.isSpreadElement(node)) {
      return strings(node.expression, seen);
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) {
        return [];
      }
      return (initializers.get(node.text) ?? []).flatMap((value) =>
        strings(value, new Set([...seen, node.text])),
      );
    }
    return [];
  };

  const stringAlternativeCache = new Map<string, string[]>();
  const stringAlternatives = (
    node: ts.Expression | undefined,
    seen = new Set<string>(),
  ): string[] => {
    const boundedUnion = (...groups: readonly string[][]): string[] => {
      const values = new Set<string>();
      for (const group of groups) {
        for (const value of group) {
          if (value === STRING_ANALYSIS_OVERFLOW) {
            return [STRING_ANALYSIS_OVERFLOW];
          }
          values.add(value);
          if (values.size > MAX_STRING_ALTERNATIVES) {
            return [STRING_ANALYSIS_OVERFLOW];
          }
        }
      }
      return [...values];
    };
    if (!node) {
      return [];
    }
    node = unwrapTransparentExpression(node);
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return [node.text];
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isPropertyAccessExpression(node.tag) &&
      ts.isIdentifier(node.tag.expression) &&
      node.tag.expression.text === "String" &&
      node.tag.name.text === "raw"
    ) {
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        return [node.template.rawText ?? node.template.text];
      }
      return stringAlternatives(node.template, seen);
    }
    if (ts.isConditionalExpression(node)) {
      return boundedUnion(
        stringAlternatives(node.whenTrue, seen),
        stringAlternatives(node.whenFalse, seen),
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    ) {
      return boundedUnion(
        stringAlternatives(node.left, seen),
        stringAlternatives(node.right, seen),
      );
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = stringAlternatives(node.left, seen);
      const right = stringAlternatives(node.right, seen);
      const leftValues = left.length > 0 ? left : [DYNAMIC_BOUNDARY];
      const rightValues = right.length > 0 ? right : [DYNAMIC_BOUNDARY];
      if (
        leftValues.includes(STRING_ANALYSIS_OVERFLOW) ||
        rightValues.includes(STRING_ANALYSIS_OVERFLOW)
      ) {
        return [STRING_ANALYSIS_OVERFLOW];
      }
      if (leftValues.length * rightValues.length > MAX_STRING_ALTERNATIVES) {
        return [STRING_ANALYSIS_OVERFLOW];
      }
      return leftValues.flatMap((prefix) => rightValues.map((suffix) => prefix + suffix));
    }
    if (ts.isTemplateExpression(node)) {
      let alternatives = [node.head.text];
      for (const span of node.templateSpans) {
        const interpolation = stringAlternatives(span.expression, seen);
        const values = interpolation.length > 0 ? interpolation : [DYNAMIC_BOUNDARY];
        if (values.includes(STRING_ANALYSIS_OVERFLOW)) {
          return [STRING_ANALYSIS_OVERFLOW];
        }
        if (alternatives.length * values.length > MAX_STRING_ALTERNATIVES) {
          return [STRING_ANALYSIS_OVERFLOW];
        }
        alternatives = alternatives.flatMap((prefix) =>
          values.map((value) => prefix + value + span.literal.text),
        );
      }
      return alternatives;
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) {
        return [];
      }
      const cacheKey = `${node.text}\u0000${[...seen].sort().join("\u0000")}`;
      const cached = stringAlternativeCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const alternatives = boundedUnion(
        ...(initializers.get(node.text) ?? []).map((value) =>
          stringAlternatives(value, new Set([...seen, node.text])),
        ),
      );
      stringAlternativeCache.set(cacheKey, alternatives);
      return alternatives;
    }
    return [];
  };

  const arrayAlternativeCache = new Map<string, ts.Expression[][] | undefined>();
  const arrayAlternatives = (
    node: ts.Expression | undefined,
    seen = new Set<string>(),
  ): ts.Expression[][] | undefined => {
    if (!node) {
      return undefined;
    }
    node = unwrapTransparentExpression(node);
    if (ts.isConditionalExpression(node)) {
      const whenTrue = arrayAlternatives(node.whenTrue, seen);
      const whenFalse = arrayAlternatives(node.whenFalse, seen);
      return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : (whenTrue ?? whenFalse);
    }
    if (ts.isArrayLiteralExpression(node)) {
      let alternatives: ts.Expression[][] = [[]];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = arrayAlternatives(element.expression, seen);
          // An unresolved spread can occupy the command position. Do not silently discard it and
          // shift later elements into that position.
          if (!spread) {
            return undefined;
          }
          alternatives = alternatives.flatMap((prefix) =>
            spread.map((value) => [...prefix, ...value]),
          );
        } else if (ts.isExpression(element)) {
          alternatives = alternatives.map((prefix) => [...prefix, element]);
        }
      }
      return alternatives;
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const cacheKey = `${node.text}\u0000${[...seen].sort().join("\u0000")}`;
      if (arrayAlternativeCache.has(cacheKey)) {
        return arrayAlternativeCache.get(cacheKey);
      }
      const next = new Set([...seen, node.text]);
      const values = initializers.get(node.text) ?? [];
      const arrays = values
        .map((value) => arrayAlternatives(value, next))
        .filter((value): value is ts.Expression[][] => value !== undefined);
      const alternatives = arrays.length > 0 ? arrays.flat() : undefined;
      arrayAlternativeCache.set(cacheKey, alternatives);
      return alternatives;
    }
    return undefined;
  };
  const arrayElements = (node: ts.Expression | undefined): ts.Expression[] | undefined => {
    const alternatives = arrayAlternatives(node);
    return alternatives?.length === 1 ? alternatives[0] : undefined;
  };
  const objectPropertyValues = (
    node: ts.Expression | undefined,
    propertyName: string,
    seen = new Set<string>(),
  ): ts.Expression[] => {
    if (!node) {
      return [];
    }
    node = unwrapTransparentExpression(node);
    if (ts.isConditionalExpression(node)) {
      return [
        ...objectPropertyValues(node.whenTrue, propertyName, seen),
        ...objectPropertyValues(node.whenFalse, propertyName, seen),
      ];
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property) && propertyNameOf(property.name) === propertyName) {
          return [property.initializer];
        }
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
          return [property.name];
        }
        return ts.isSpreadAssignment(property)
          ? objectPropertyValues(property.expression, propertyName, seen)
          : [];
      });
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      return (initializers.get(node.text) ?? []).flatMap((value) =>
        objectPropertyValues(value, propertyName, new Set([...seen, node.text])),
      );
    }
    return [];
  };
  const containsCallNamed = (
    node: ts.Expression | undefined,
    names: ReadonlySet<string>,
    seen = new Set<string>(),
  ): boolean => {
    if (!node) {
      return false;
    }
    if (ts.isCallExpression(node) && names.has(propertyName(node.expression) ?? "")) {
      return true;
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) {
        return false;
      }
      return (initializers.get(node.text) ?? []).some((value) =>
        containsCallNamed(value, names, new Set([...seen, node.text])),
      );
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsCallNamed(child as ts.Expression, names, seen)) {
        found = true;
      }
    });
    return found;
  };

  return {
    calls,
    calleeName: (call) => propertyName(call.expression),
    isLauncher: (call) =>
      (ts.isIdentifier(call.expression) && launcherAliases.has(call.expression.text)) ||
      ((ts.isPropertyAccessExpression(call.expression) ||
        ts.isElementAccessExpression(call.expression)) &&
        propertyName(call.expression) !== undefined &&
        ((ts.isIdentifier(call.expression.expression) &&
          childProcessNamespaces.has(call.expression.expression.text) &&
          PROCESS_LAUNCHERS.has(propertyName(call.expression) ?? "")) ||
          (PROCESS_LAUNCHERS.has(propertyName(call.expression) ?? "") &&
            /(?:executor|host|process)/i.test(call.expression.expression.getText(sourceFile))) ||
          ["execFile", "execFileSync", "execFileAsync"].includes(
            propertyName(call.expression) ?? "",
          ) ||
          INJECTED_LAUNCHERS.has(propertyName(call.expression) ?? "") ||
          (ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Bun" &&
            ["spawn", "spawnSync"].includes(propertyName(call.expression) ?? "")))),
    isExecutionSeam: (call) => isExecutionSeamReference(call.expression),
    isRunExecSeam: (call) => isRunExecSeamReference(call.expression),
    strings,
    stringAlternatives,
    arrayAlternatives,
    arrayElements,
    objectPropertyValues,
    containsCallNamed,
  };
}
