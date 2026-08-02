import ts from "typescript";

export const PROCESS_LAUNCHERS = new Set([
  "spawn", "spawnSync", "spawnCommand", "exec", "execSync", "execFile", "execFileSync",
  "execFileAsync",
]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const INJECTED_LAUNCHERS = new Set(["spawn", "spawnSync"]);
const DYNAMIC_BOUNDARY = "\u0000";

export interface ExecutionBoundaryAst {
  readonly calls: readonly ts.CallExpression[];
  calleeName(call: ts.CallExpression): string | undefined;
  isLauncher(call: ts.CallExpression): boolean;
  isExecutionSeam(call: ts.CallExpression): boolean;
  isRunExecSeam(call: ts.CallExpression): boolean;
  strings(node: ts.Expression | undefined): string[];
  arrayAlternatives(node: ts.Expression | undefined): ts.Expression[][] | undefined;
  arrayElements(node: ts.Expression | undefined): ts.Expression[] | undefined;
  objectPropertyValues(node: ts.Expression | undefined, propertyName: string): ts.Expression[];
  containsCallNamed(node: ts.Expression | undefined, names: ReadonlySet<string>): boolean;
}

function propertyName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {return expression.text;}
  if (ts.isPropertyAccessExpression(expression)) {return expression.name.text;}
  return undefined;
}

function propertyNameOf(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
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
  const sourceFile = ts.createSourceFile("execution-boundary.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const initializers = new Map<string, ts.Expression[]>();
  const calls: ts.CallExpression[] = [];
  const launcherAliases = new Set(PROCESS_LAUNCHERS);
  const executionSeamAliases = new Set(["executeCommand", "runExecSeam", "execute"]);
  const runExecSeamAliases = new Set(["runExecSeam"]);
  const childProcessNamespaces = new Set<string>();
  const bind = (name: string, value: ts.Expression): void => initializers.set(name, [...(initializers.get(name) ?? []), value]);
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {childProcessNamespaces.add(bindings.name.text);}
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (PROCESS_LAUNCHERS.has(imported)) {launcherAliases.add(element.name.text);}
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression) &&
      CHILD_PROCESS_MODULES.has(node.moduleReference.expression.text)) {
      childProcessNamespaces.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) {bind(node.name.text, node.initializer);}
      if (ts.isObjectBindingPattern(node.name)) {
        const initializer = node.initializer;
        const fromChildProcess = initializer && ((ts.isIdentifier(initializer) && childProcessNamespaces.has(initializer.text)) ||
          (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === "require" &&
            initializer.arguments.length === 1 && ts.isStringLiteral(initializer.arguments[0]) && CHILD_PROCESS_MODULES.has(initializer.arguments[0].text)));
        for (const element of node.name.elements) {
          const property = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : undefined;
          if (fromChildProcess && property && ts.isIdentifier(element.name) && PROCESS_LAUNCHERS.has(property)) {
            launcherAliases.add(element.name.text);
          }
        }
      }
      if (ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require" &&
        node.initializer.arguments.length === 1 && ts.isStringLiteral(node.initializer.arguments[0]) &&
        CHILD_PROCESS_MODULES.has(node.initializer.arguments[0].text)) {
        childProcessNamespaces.add(node.name.text);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      bind(node.left.text, node.right);
    }
    if (ts.isCallExpression(node)) {calls.push(node);}
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const isPromisifiedLauncher = (node: ts.Expression): boolean => ts.isCallExpression(node) && node.arguments.length === 1 &&
    propertyName(node.expression) === "promisify" && isLauncherReference(node.arguments[0]);
  const isLauncherReference = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && launcherAliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) && PROCESS_LAUNCHERS.has(node.name.text) &&
      ts.isIdentifier(node.expression) && childProcessNamespaces.has(node.expression.text)) ||
    isPromisifiedLauncher(node);
  const isExecutionSeamReference = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && executionSeamAliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) && (
      node.name.text === "executeCommand" || node.name.text === "runExecSeam" ||
      (node.name.text === "execute" && (node.expression.kind === ts.SyntaxKind.ThisKeyword ||
        /(?:executor|host|process)/i.test(node.expression.getText(sourceFile))))
    ));
  const isRunExecSeamReference = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && runExecSeamAliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "runExecSeam");
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, values] of initializers) {
      if (!launcherAliases.has(name) && values.some(isLauncherReference)) {
        launcherAliases.add(name); changed = true;
      }
      if (!executionSeamAliases.has(name) && values.some(isExecutionSeamReference)) {
        executionSeamAliases.add(name); changed = true;
      }
      if (!runExecSeamAliases.has(name) && values.some(isRunExecSeamReference)) {
        runExecSeamAliases.add(name); changed = true;
      }
    }
  }

  const strings = (node: ts.Expression | undefined, seen = new Set<string>()): string[] => {
    if (!node) {return [];}
    node = unwrapTransparentExpression(node);
    if (ts.isStringLiteralLike(node)) {return [node.text];}
    if (ts.isParenthesizedExpression(node)) {return strings(node.expression, seen);}
    if (ts.isNoSubstitutionTemplateLiteral(node)) {return [node.text];}
    if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag) &&
      ts.isIdentifier(node.tag.expression) && node.tag.expression.text === "String" && node.tag.name.text === "raw") {
      return strings(node.template, seen);
    }
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) {
        const interpolation = strings(span.expression, seen);
        if (interpolation.length > 0 && interpolation.every(value => !value.includes(DYNAMIC_BOUNDARY))) {
          values = values.flatMap(prefix => interpolation.map(value => prefix + value + span.literal.text));
        } else {
          values = [...values, DYNAMIC_BOUNDARY, span.literal.text];
        }
      }
      return values;
    }
    if (ts.isConditionalExpression(node)) {
      return [...strings(node.whenTrue, seen), ...strings(node.whenFalse, seen)];
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      return [...strings(node.left, seen), ...strings(node.right, seen)];
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = strings(node.left, seen); const right = strings(node.right, seen);
      const staticLeft = left.length === 1 && !left[0].includes(DYNAMIC_BOUNDARY);
      const staticRight = right.length === 1 && !right[0].includes(DYNAMIC_BOUNDARY);
      if (staticLeft && staticRight) {return [left[0] + right[0]];}
      return [...left, DYNAMIC_BOUNDARY, ...right];
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

  const arrayAlternatives = (node: ts.Expression | undefined, seen = new Set<string>()): ts.Expression[][] | undefined => {
    if (!node) {return undefined;}
    node = unwrapTransparentExpression(node);
    if (ts.isConditionalExpression(node)) {
      const whenTrue = arrayAlternatives(node.whenTrue, seen);
      const whenFalse = arrayAlternatives(node.whenFalse, seen);
      return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : whenTrue ?? whenFalse;
    }
    if (ts.isArrayLiteralExpression(node)) {
      let alternatives: ts.Expression[][] = [[]];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = arrayAlternatives(element.expression, seen);
          // An unresolved spread can occupy the command position. Do not silently discard it and
          // shift later elements into that position.
          if (!spread) {return undefined;}
          alternatives = alternatives.flatMap(prefix => spread.map(value => [...prefix, ...value]));
        } else if (ts.isExpression(element)) {
          alternatives = alternatives.map(prefix => [...prefix, element]);
        }
      }
      return alternatives;
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const next = new Set([...seen, node.text]);
      const values = initializers.get(node.text) ?? [];
      const arrays = values.map(value => arrayAlternatives(value, next)).filter((value): value is ts.Expression[][] => value !== undefined);
      return arrays.length > 0 ? arrays.flat() : undefined;
    }
    return undefined;
  };
  const arrayElements = (node: ts.Expression | undefined): ts.Expression[] | undefined => {
    const alternatives = arrayAlternatives(node);
    return alternatives?.length === 1 ? alternatives[0] : undefined;
  };
  const objectPropertyValues = (node: ts.Expression | undefined, propertyName: string, seen = new Set<string>()): ts.Expression[] => {
    if (!node) {return [];}
    node = unwrapTransparentExpression(node);
    if (ts.isConditionalExpression(node)) {
      return [...objectPropertyValues(node.whenTrue, propertyName, seen),
        ...objectPropertyValues(node.whenFalse, propertyName, seen)];
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap(property => {
        if (ts.isPropertyAssignment(property) && propertyNameOf(property.name) === propertyName) {return [property.initializer];}
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {return [property.name];}
        return ts.isSpreadAssignment(property) ? objectPropertyValues(property.expression, propertyName, seen) : [];
      });
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      return (initializers.get(node.text) ?? []).flatMap(value =>
        objectPropertyValues(value, propertyName, new Set([...seen, node.text])));
    }
    return [];
  };
  const containsCallNamed = (node: ts.Expression | undefined, names: ReadonlySet<string>, seen = new Set<string>()): boolean => {
    if (!node) {return false;}
    if (ts.isCallExpression(node) && names.has(propertyName(node.expression) ?? "")) {return true;}
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) {return false;}
      return (initializers.get(node.text) ?? []).some(value => containsCallNamed(value, names, new Set([...seen, node.text])));
    }
    let found = false;
    ts.forEachChild(node, child => {if (!found && containsCallNamed(child as ts.Expression, names, seen)) {found = true;}});
    return found;
  };

  return {
    calls,
    calleeName: call => propertyName(call.expression),
    isLauncher: call => (ts.isIdentifier(call.expression) && launcherAliases.has(call.expression.text)) ||
      (ts.isPropertyAccessExpression(call.expression) &&
        ((ts.isIdentifier(call.expression.expression) && childProcessNamespaces.has(call.expression.expression.text) && PROCESS_LAUNCHERS.has(call.expression.name.text)) ||
          (PROCESS_LAUNCHERS.has(call.expression.name.text) &&
            /(?:executor|host|process)/i.test(call.expression.expression.getText(sourceFile))) ||
          ["execFile", "execFileSync", "execFileAsync"].includes(call.expression.name.text) ||
          INJECTED_LAUNCHERS.has(call.expression.name.text) ||
          (ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "Bun" &&
            ["spawn", "spawnSync"].includes(call.expression.name.text)))),
    isExecutionSeam: call => isExecutionSeamReference(call.expression),
    isRunExecSeam: call => isRunExecSeamReference(call.expression),
    strings,
    arrayAlternatives,
    arrayElements,
    objectPropertyValues,
    containsCallNamed,
  };
}
