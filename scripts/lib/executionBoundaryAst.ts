import ts from "typescript";

export const PROCESS_LAUNCHERS = new Set([
  "spawn", "spawnSync", "spawnCommand", "exec", "execSync", "execFile", "execFileSync",
  "execFileAsync",
]);

export interface ExecutionBoundaryAst {
  readonly calls: readonly ts.CallExpression[];
  calleeName(call: ts.CallExpression): string | undefined;
  isLauncher(call: ts.CallExpression): boolean;
  isExecutionSeam(call: ts.CallExpression): boolean;
  strings(node: ts.Expression | undefined): string[];
  arrayElements(node: ts.Expression | undefined): ts.Expression[] | undefined;
  containsCallNamed(node: ts.Expression | undefined, names: ReadonlySet<string>): boolean;
}

function propertyName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {return expression.text;}
  if (ts.isPropertyAccessExpression(expression)) {return expression.name.text;}
  return undefined;
}

/**
 * Parses one TypeScript source file and provides conservative, scope-insensitive value flow for
 * execution-boundary guards. A value bound anywhere to a bare name is considered at every use:
 * that can produce a loud false-positive, but cannot silently let an alias or injected seam hide
 * a prohibited launcher call.
 */
export function executionBoundaryAst(source: string): ExecutionBoundaryAst {
  const sourceFile = ts.createSourceFile("execution-boundary.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const initializers = new Map<string, ts.Expression[]>();
  const declarations: ts.VariableDeclaration[] = [];
  const calls: ts.CallExpression[] = [];
  const bind = (name: string, value: ts.Expression): void => initializers.set(name, [...(initializers.get(name) ?? []), value]);
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      if (ts.isIdentifier(node.name) && node.initializer) {bind(node.name.text, node.initializer);}
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      bind(node.left.text, node.right);
    }
    if (ts.isCallExpression(node)) {calls.push(node);}
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const launcherAliases = new Set(PROCESS_LAUNCHERS);
  const executionSeamAliases = new Set(["executeCommand", "runExecSeam", "execute"]);
  const isPromisifiedLauncher = (node: ts.Expression): boolean => ts.isCallExpression(node) && node.arguments.length === 1 &&
    propertyName(node.expression) === "promisify" && isLauncherReference(node.arguments[0]);
  const isLauncherReference = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && launcherAliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) && PROCESS_LAUNCHERS.has(node.name.text)) ||
    isPromisifiedLauncher(node);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer &&
        isLauncherReference(declaration.initializer) && !launcherAliases.has(declaration.name.text)) {
        launcherAliases.add(declaration.name.text);
        changed = true;
      }
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer) &&
        executionSeamAliases.has(declaration.initializer.text) && !executionSeamAliases.has(declaration.name.text)) {
        executionSeamAliases.add(declaration.name.text);
        changed = true;
      }
    }
  }

  const strings = (node: ts.Expression | undefined, seen = new Set<string>()): string[] => {
    if (!node) {return [];}
    if (ts.isStringLiteralLike(node)) {return [node.text];}
    if (ts.isParenthesizedExpression(node)) {return strings(node.expression, seen);}
    if (ts.isNoSubstitutionTemplateLiteral(node)) {return [node.text];}
    if (ts.isTemplateExpression(node)) {return [node.head.text, ...node.templateSpans.map(span => span.literal.text)];}
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = strings(node.left, seen); const right = strings(node.right, seen);
      return left.length === 1 && right.length === 1 ? [left[0] + right[0]] : [...left, ...right];
    }
    if (ts.isArrayLiteralExpression(node)) {return node.elements.flatMap(element => ts.isExpression(element) ? strings(element, seen) : []);}
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap(property =>
        ts.isPropertyAssignment(property) ? strings(property.initializer, seen) : []);
    }
    if (ts.isSpreadElement(node)) {return strings(node.expression, seen);}
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) {return [];}
      return (initializers.get(node.text) ?? []).flatMap(value => strings(value, new Set([...seen, node.text])));
    }
    return [];
  };

  const arrayElements = (node: ts.Expression | undefined, seen = new Set<string>()): ts.Expression[] | undefined => {
    if (!node) {return undefined;}
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap(element =>
        ts.isSpreadElement(element) ? arrayElements(element.expression, seen) ?? [] : ts.isExpression(element) ? [element] : []);
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const next = new Set([...seen, node.text]);
      const values = initializers.get(node.text) ?? [];
      const arrays = values.map(value => arrayElements(value, next)).filter((value): value is ts.Expression[] => value !== undefined);
      return arrays.length > 0 ? arrays.flat() : undefined;
    }
    return undefined;
  };
  const containsCallNamed = (node: ts.Expression | undefined, names: ReadonlySet<string>, seen = new Set<string>()): boolean => {
    if (!node) {return false;}
    if (ts.isCallExpression(node) && names.has(propertyName(node.expression) ?? "")) {return true;}
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) {return false;}
      return (initializers.get(node.text) ?? []).some(value => containsCallNamed(value, names, new Set([...seen, node.text])));
    }
    let found = false;
    ts.forEachChild(node, child => {if (!found && ts.isExpression(child) && containsCallNamed(child, names, seen)) {found = true;}});
    return found;
  };

  return {
    calls,
    calleeName: call => propertyName(call.expression),
    isLauncher: call => (propertyName(call.expression) !== undefined && launcherAliases.has(propertyName(call.expression)!)) ||
      (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Bun" && ["spawn", "spawnSync"].includes(call.expression.name.text)),
    isExecutionSeam: call => executionSeamAliases.has(propertyName(call.expression) ?? ""),
    strings,
    arrayElements,
    containsCallNamed,
  };
}
