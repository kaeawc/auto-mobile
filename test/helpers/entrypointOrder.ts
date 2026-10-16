import ts from "typescript";

/**
 * AST helpers for tests that pin the ORDER of startup statements in an entrypoint
 * (src/index.ts, Daemon.start). They replace `indexOf` over source text: matching is
 * by node kind and node text, so comments, strings and formatting cannot satisfy or
 * break a guard, and every check takes source text so a test can also feed it a
 * mutated copy and prove the guard fails.
 */
export function parseSource(source: string, fileName = "entrypoint.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function walk(root: ts.Node, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, step);
  };
  step(root);
}

export function findAll<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  walk(root, (node) => {
    if (predicate(node)) {
      found.push(node);
    }
  });
  return found.sort((a, b) => a.getStart() - b.getStart());
}

/** The body of a named function, or undefined when it is absent. */
export function functionBody(sf: ts.SourceFile, name: string): ts.Block | undefined {
  return findAll(sf, ts.isFunctionDeclaration).find((fn) => fn.name?.text === name)?.body;
}

function stringArg(call: ts.CallExpression, index = 0): string | undefined {
  const arg = call.arguments[index];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/** `import("spec")` expressions; every one when `spec` is omitted. */
export function dynamicImports(root: ts.Node, spec?: string): ts.CallExpression[] {
  return findAll(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      (spec === undefined || stringArg(node) === spec),
  );
}

/** Calls whose callee text is exactly `callee`, optionally matching the first string/identifier argument. */
export function callsTo(root: ts.Node, callee: string, firstArg?: string): ts.CallExpression[] {
  return findAll(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText() === callee &&
      (firstArg === undefined ||
        (node.arguments[0] !== undefined && node.arguments[0].getText() === firstArg)),
  );
}

export function newExpressions(root: ts.Node, className: string): ts.NewExpression[] {
  return findAll(
    root,
    (node): node is ts.NewExpression =>
      ts.isNewExpression(node) && node.expression.getText() === className,
  );
}

/** `if (<condition text>)` statements, matched on the exact condition text. */
export function ifStatements(root: ts.Node, condition: string): ts.IfStatement[] {
  return findAll(
    root,
    (node): node is ts.IfStatement =>
      ts.isIfStatement(node) && node.expression.getText() === condition,
  );
}

export function variableDeclarations(
  root: ts.Node,
  name: string,
  initializerText?: string,
): ts.VariableDeclaration[] {
  return findAll(
    root,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      node.name.getText() === name &&
      (initializerText === undefined || node.initializer?.getText() === initializerText),
  );
}

export function contains(outer: ts.Node, inner: ts.Node): boolean {
  return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();
}

/**
 * Accumulates ordering violations. `before(a, b)` requires a to end before b starts
 * (a statement that finishes before another begins); a missing node is itself a violation.
 */
export class OrderCheck {
  readonly violations: string[] = [];

  require<T extends ts.Node>(label: string, nodes: readonly T[]): T | undefined {
    const node = nodes[0];
    if (node === undefined) {
      this.violations.push(`missing ${label}`);
    }
    return node;
  }

  before(labelA: string, a: ts.Node | undefined, labelB: string, b: ts.Node | undefined): void {
    if (a && b && a.getEnd() > b.getStart()) {
      this.violations.push(`${labelA} must come before ${labelB}`);
    }
  }

  within(
    labelInner: string,
    inner: ts.Node | undefined,
    labelOuter: string,
    outer?: ts.Node,
  ): void {
    if (inner && outer && !contains(outer, inner)) {
      this.violations.push(`${labelInner} must be inside ${labelOuter}`);
    }
  }
}

/** Swap the source text of two non-overlapping nodes: the mutation used to prove an ordering guard fails. */
export function swapNodes(source: string, a: ts.Node, b: ts.Node): string {
  const [first, second] = a.getStart() < b.getStart() ? [a, b] : [b, a];
  return (
    source.slice(0, first.getStart()) +
    source.slice(second.getStart(), second.getEnd()) +
    source.slice(first.getEnd(), second.getStart()) +
    source.slice(first.getStart(), first.getEnd()) +
    source.slice(second.getEnd())
  );
}
