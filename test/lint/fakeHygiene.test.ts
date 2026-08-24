import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Source-scan ratchet: a test double under test/fakes must not reach for the
 * real clock (`defaultTimer`, `Date.now()`) or real randomness (`Math.random()`,
 * `randomUUID()`). Those are exactly the non-determinism the fake seam exists to
 * remove, so a fake that uses them silently reintroduces flake (issue #4186).
 *
 * `Math.random(`/`randomUUID(` are HARD-banned (zero occurrences allowed). The
 * pre-existing `defaultTimer`/`Date.now(` uses are recorded PER OCCURRENCE below
 * (keyed by trimmed source line, with multiplicity) so the scan is green today
 * yet fails on any NEW occurrence — and, crucially, a per-occurrence key means a
 * sanctioned `?? Date.now()` line does not whitelist a sibling raw `Date.now()`
 * in the same file. Prefer removing an entry (inject a Timer/FakeTimer) over
 * growing the allowlist.
 */

const FAKES_DIR = path.join(import.meta.dir, "..", "fakes");

// relative filename -> trimmed source lines that are allowed to contain a
// forbidden token (duplicates listed once per occurrence).
const ALLOWLIST: Record<string, string[]> = {
  "FakeIOSCtrlProxy.ts": [
    'import { defaultTimer } from "../../src/utils/SystemTimer";',
    "await defaultTimer.sleep(delay);",
    "timestamp: Date.now(),",
  ],
  "FakeWebSocket.ts": [
    'import { defaultTimer } from "../../src/utils/SystemTimer";',
    "timer: Timer = defaultTimer,",
  ],
  "FakeCtrlProxy.ts": [
    'import { defaultTimer } from "../../src/utils/SystemTimer";',
    "await defaultTimer.sleep(delay);",
    "timestamp: Date.now(),",
  ],
  "FakeObserveCacheStore.ts": [
    'import { Timer, defaultTimer } from "../../src/utils/SystemTimer";',
    "constructor(timer: Timer = defaultTimer) {",
  ],
  "FakeChildProcess.ts": [
    'import { defaultTimer } from "../../src/utils/SystemTimer";',
    "defaultTimer.setTimeout(() => {",
    "defaultTimer.setTimeout(() => {",
  ],
  "FakeNavigationGraphManager.ts": ["timestamp: Date.now(),"],
  "FakeAdbExecutor.ts": ["return this.deviceTimestampMs ?? Date.now();"],
  "FakeAdbClientFactory.ts": ["timestamp: Date.now(),"],
  "FakeSetUIStateDependencies.ts": ["updatedAt: Date.now(),"],
  "FakeSimctl.ts": ["pid: Date.now(),"],
  "ResultFaker.ts": ["const updatedAt = overrides.updatedAt ?? Date.now();"],
  "FakeFailureRecorder.ts": [
    "timestamp: Date.now(),",
    "timestamp: Date.now(),",
    "timestamp: Date.now(),",
    "timestamp: Date.now(),",
  ],
  "FakeAwaitIdle.ts": ["const now = Date.now();"],
};

type ForbiddenMethod = "Date.now" | "Math.random" | "crypto.randomUUID";
type StandardObject = "Date" | "Math" | "crypto";
type ForbiddenValue = StandardObject | ForbiddenMethod | "defaultTimer";

class Scope {
  private readonly bindings = new Map<string, ForbiddenValue | null>();

  constructor(private readonly parent?: Scope) {}

  bind(name: string, value: ForbiddenValue | null): void {
    this.bindings.set(name, value);
  }

  lookup(name: string): ForbiddenValue | null | undefined {
    if (this.bindings.has(name)) {
      return this.bindings.get(name);
    }
    return this.parent?.lookup(name);
  }
}

function standardObjectFor(expression: ts.Expression, scope: Scope): StandardObject | undefined {
  if (ts.isIdentifier(expression)) {
    const binding = scope.lookup(expression.text);
    if (binding === "Date" || binding === "Math" || binding === "crypto") {
      return binding;
    }
    if (binding !== undefined) {
      return undefined;
    }
    if (expression.text === "Date" || expression.text === "Math" || expression.text === "crypto") {
      return expression.text;
    }
    return undefined;
  }

  const globalPropertyName = (value: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
      return value.expression.text === "globalThis" && scope.lookup("globalThis") === undefined
        ? value.name.text
        : undefined;
    }
    if (
      ts.isElementAccessExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === "globalThis" &&
      scope.lookup("globalThis") === undefined &&
      ts.isStringLiteral(value.argumentExpression)
    ) {
      return value.argumentExpression.text;
    }
    return undefined;
  };
  const name = globalPropertyName(expression);
  return name === "Date" || name === "Math" || name === "crypto" ? name : undefined;
}

function forbiddenMethodForProperty(
  object: StandardObject | undefined,
  property: string,
): ForbiddenMethod | undefined {
  if (object === "Date" && property === "now") {
    return "Date.now";
  }
  if (object === "Math" && property === "random") {
    return "Math.random";
  }
  if (object === "crypto" && property === "randomUUID") {
    return "crypto.randomUUID";
  }
  return undefined;
}

function forbiddenMethodFor(expression: ts.Expression, scope: Scope): ForbiddenMethod | undefined {
  if (ts.isIdentifier(expression)) {
    const binding = scope.lookup(expression.text);
    if (binding === "Date.now" || binding === "Math.random" || binding === "crypto.randomUUID") {
      return binding;
    }
    if (expression.text === "randomUUID" && binding === undefined) {
      return "crypto.randomUUID";
    }
    return undefined;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return forbiddenMethodForProperty(
      standardObjectFor(expression.expression, scope),
      expression.name.text,
    );
  }

  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return forbiddenMethodForProperty(
      standardObjectFor(expression.expression, scope),
      expression.argumentExpression.text,
    );
  }

  return undefined;
}

function bindName(scope: Scope, name: ts.BindingName, value: ForbiddenValue | null): void {
  if (ts.isIdentifier(name)) {
    scope.bind(name.text, value);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      bindName(scope, element.name, null);
    }
  }
}

function isDefaultTimer(expression: ts.Expression, scope: Scope): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== "defaultTimer") {
    return false;
  }
  return scope.lookup(expression.text) !== null;
}

function bindVariableDeclaration(declaration: ts.VariableDeclaration, scope: Scope): void {
  const initializer = declaration.initializer;
  if (!initializer) {
    bindName(scope, declaration.name, null);
    return;
  }

  const object = standardObjectFor(initializer, scope);
  const method = forbiddenMethodFor(initializer, scope);
  const value = object ?? method ?? (isDefaultTimer(initializer, scope) ? "defaultTimer" : null);
  if (ts.isIdentifier(declaration.name)) {
    bindName(scope, declaration.name, value);
    return;
  }

  if (ts.isObjectBindingPattern(declaration.name) && object) {
    for (const element of declaration.name.elements) {
      const property = element.propertyName ?? element.name;
      const propertyName =
        ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined;
      bindName(
        scope,
        element.name,
        propertyName ? (forbiddenMethodForProperty(object, propertyName) ?? null) : null,
      );
    }
    return;
  }

  bindName(scope, declaration.name, null);
}

function forbiddenLinesIn(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "fake.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const lines: string[] = [];

  const lineAt = (position: number): string => {
    const line = sourceFile.getLineAndCharacterOfPosition(position).line;
    return sourceFile.text.split("\n")[line]?.trim() ?? "";
  };
  const reportDefaultTimer = (identifier: ts.Identifier, scope: Scope): void => {
    if (identifier.text === "defaultTimer" && scope.lookup(identifier.text) !== null) {
      lines.push(lineAt(identifier.getStart(sourceFile)));
    }
  };
  const bindImport = (declaration: ts.ImportDeclaration, scope: Scope): void => {
    const importedBindings = declaration.importClause;
    if (!importedBindings) {
      return;
    }
    if (importedBindings.name) {
      bindName(scope, importedBindings.name, null);
    }
    if (!importedBindings.namedBindings || !ts.isNamedImports(importedBindings.namedBindings)) {
      return;
    }
    for (const element of importedBindings.namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      const value =
        importedName === "defaultTimer"
          ? "defaultTimer"
          : importedName === "randomUUID" &&
              declaration.moduleSpecifier.getText(sourceFile).includes("crypto")
            ? "crypto.randomUUID"
            : null;
      bindName(scope, element.name, value);
      if (value === "defaultTimer") {
        reportDefaultTimer(element.name, scope);
      }
    }
  };
  const visit = (node: ts.Node, scope: Scope): void => {
    if (ts.isSourceFile(node)) {
      for (const statement of node.statements) {
        visit(statement, scope);
      }
      return;
    }
    if (ts.isBlock(node)) {
      const blockScope = new Scope(scope);
      for (const statement of node.statements) {
        visit(statement, blockScope);
      }
      return;
    }
    if (ts.isImportDeclaration(node)) {
      bindImport(node, scope);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) {
        visit(node.initializer, scope);
      }
      bindVariableDeclaration(node, scope);
      return;
    }
    if (ts.isFunctionLike(node)) {
      const functionScope = new Scope(scope);
      for (const parameter of node.parameters) {
        if (parameter.initializer) {
          visit(parameter.initializer, scope);
        }
        bindName(functionScope, parameter.name, null);
      }
      if (node.body) {
        visit(node.body, functionScope);
      }
      return;
    }
    if (ts.isClassDeclaration(node)) {
      const classScope = new Scope(scope);
      if (node.name) {
        classScope.bind(node.name.text, null);
      }
      ts.forEachChild(node, (child) => visit(child, classScope));
      return;
    }
    if (ts.isIdentifier(node)) {
      reportDefaultTimer(node, scope);
      return;
    }
    if (ts.isCallExpression(node) && forbiddenMethodFor(node.expression, scope)) {
      lines.push(lineAt(node.getStart(sourceFile)));
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };

  visit(sourceFile, new Scope());
  return lines;
}

function sortedMultiset(values: string[]): string[] {
  return [...values].sort();
}

describe("fake hygiene source scan (#4186)", () => {
  const fakeFiles = readdirSync(FAKES_DIR).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );

  test("rejects aliased, computed, and whitespace-obscured nondeterminism", () => {
    const bypasses = [
      "const { random } = Math; random()",
      "Math . random()",
      'Math["random"]()',
      'crypto["randomUUID"]()',
      "const clock = Date; clock.now()",
      'Date["now"]()',
      "const { now } = Date; now()",
      "const { randomUUID: makeId } = crypto; makeId()",
      "globalThis.Date.now()",
    ];

    for (const source of bypasses) {
      expect(forbiddenLinesIn(source)).toHaveLength(1);
    }
  });

  test("does not flag shadowed local clock and randomness methods", () => {
    const source = `
      function safe(
        Date: { now(): number },
        Math: { random(): number },
        crypto: { randomUUID(): string }
      ) {
        return [Date.now(), Math.random(), crypto["randomUUID"]()];
      }
    `;

    expect(forbiddenLinesIn(source)).toEqual([]);
  });

  test("scans a non-trivial number of fakes", () => {
    // Guards against a glob/path regression silently scanning nothing.
    expect(fakeFiles.length).toBeGreaterThan(50);
  });

  for (const fileName of fakeFiles) {
    test(`${fileName} introduces no new real-clock / real-randomness use`, () => {
      const source = readFileSync(path.join(FAKES_DIR, fileName), "utf8");
      const found = forbiddenLinesIn(source);
      const allowed = ALLOWLIST[fileName] ?? [];

      expect(sortedMultiset(found)).toEqual(sortedMultiset(allowed));
    });
  }
});
