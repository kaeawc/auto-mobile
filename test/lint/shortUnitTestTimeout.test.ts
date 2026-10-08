import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fileURLToPath } from "node:url";

// The independent Node Unit Timing Budget job measures isolated medians. Test
// runner deadlines this tight instead fail on scheduler stalls on loaded CI.
function shortTimeouts(source: string): string[] {
  // This rule reads syntax and explicit line comments, never JSDoc or parents.
  const file = ts.createSourceFile(
    "unit.test.ts",
    source,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
  );
  let comments: Array<{ line: number; text: string; standalone: boolean }> | undefined;
  const exemptionComments = () => {
    if (comments) {
      return comments;
    }
    const scanned: Array<{ line: number; text: string; standalone: boolean }> = [];
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      source,
    );
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
        scanned.push({
          line: file.getLineAndCharacterOfPosition(scanner.getTokenPos()).line,
          text: scanner.getTokenText(),
          standalone:
            source
              .slice(source.lastIndexOf("\n", scanner.getTokenPos() - 1) + 1, scanner.getTokenPos())
              .trim().length === 0,
        });
      }
    }
    comments = scanned;
    return comments;
  };
  const scopes: Map<string, number | undefined>[] = [];
  const found: string[] = [];
  const numericValue = (node: ts.Expression): number | undefined => {
    if (ts.isNumericLiteral(node)) {
      return Number(node.text);
    }
    if (ts.isIdentifier(node)) {
      return scopes.findLast((scope) => scope.has(node.text))?.get(node.text);
    }
    return undefined;
  };
  const testCallee = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) {
      return ["test", "it", "describe"].includes(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return (
        ["only", "skip", "todo", "concurrent", "serial", "failing", "each"].includes(
          node.name.text,
        ) && testCallee(node.expression)
      );
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      return node.expression.name.text === "each" && testCallee(node.expression.expression);
    }
    return false;
  };
  function visit(node: ts.Node): void {
    const scoped = ts.isSourceFile(node) || ts.isBlock(node);
    if (scoped) {
      const scope = new Map<string, number | undefined>();
      for (const statement of node.statements) {
        if (!ts.isVariableStatement(statement)) {
          continue;
        }
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            continue;
          }
          scope.set(
            declaration.name.text,
            statement.declarationList.flags & ts.NodeFlags.Const &&
              declaration.initializer &&
              ts.isNumericLiteral(declaration.initializer)
              ? Number(declaration.initializer.text)
              : undefined,
          );
        }
      }
      scopes.push(scope);
    }
    if (ts.isCallExpression(node) && testCallee(node.expression) && node.arguments.length >= 3) {
      const argument = node.arguments[2];
      const options = ts.isObjectLiteralExpression(argument)
        ? argument.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) && property.name.getText(file) === "timeout",
          )
        : undefined;
      const timeout = options && ts.isPropertyAssignment(options) ? options.initializer : argument;
      const value = numericValue(timeout);
      if (value !== undefined && value >= 0 && value <= 1000) {
        const callLine = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
        const timeoutLine = file.getLineAndCharacterOfPosition(timeout.getStart(file)).line;
        const allowed = exemptionComments().some(
          ({ line, text, standalone }) =>
            ([callLine, timeoutLine].includes(line) ||
              (standalone && [callLine - 1, timeoutLine - 1].includes(line))) &&
            /^\/\/\s*allow-short-test-timeout:\s*\S/.test(text),
        );
        if (!allowed) {
          found.push(`${callLine + 1}: short test timeout ${value}ms`);
        }
      }
    }
    ts.forEachChild(node, visit);
    if (scoped) {
      scopes.pop();
    }
  }
  visit(file);
  return found;
}

describe("unit tests use the default runner deadline", () => {
  test.each([
    'test("case", () => {}, 100)',
    'it("case", () => {}, 1_000)',
    'test.each([1])("case", () => {}, 500)',
    'it.concurrent.each([1])("case", () => {}, 250)',
    'const FAST_TEST_TIMEOUT_MS = 100; test("case", () => {}, FAST_TEST_TIMEOUT_MS)',
    'describe("suite", () => {}, { timeout: 100 })',
    'test("case", () => {}, { timeout: 1000 })',
  ])("rejects a short deadline: %s", (source) => {
    expect(shortTimeouts(source)).toHaveLength(1);
  });

  test("accepts defaults, long deadlines, unused constants and unrelated calls", () => {
    expect(
      shortTimeouts(`
      const UNUSED_TIMEOUT_MS = 100;
      test("default", () => {});
      it("slow", () => {}, 1001);
      test.each([1])("slow", () => {}, 30_000);
      beforeAll(() => {}, 100);
      executor.test("operation", () => {}, 100);
      // test("comment", () => {}, 100);
      const fixture = 'test("string", () => {}, 100)';
    `),
    ).toEqual([]);
  });

  test("resolves constants in their lexical block without confusing shadowed names", () => {
    expect(
      shortTimeouts(`
      const TEST_TIMEOUT_MS = 100;
      describe("suite", () => {
        const TEST_TIMEOUT_MS = 5000;
        test("long", () => {}, TEST_TIMEOUT_MS);
      });
      test("short", () => {}, TEST_TIMEOUT_MS);
    `),
    ).toHaveLength(1);
  });

  test("allows reasoned opt-outs beside the call or timeout", () => {
    expect(
      shortTimeouts(`
      // allow-short-test-timeout: exercises runner timeout reporting
      test("before", () => {}, 100);
      it("same", () => {}, 100); // allow-short-test-timeout: runner fixture
      test("multiline", () => {},
        // allow-short-test-timeout: runner fixture
        100);
    `),
    ).toEqual([]);
  });

  test("requires a real comment with a reason and does not exempt the next test", () => {
    expect(
      shortTimeouts(`
      const text = '// allow-short-test-timeout: fake exemption';
      test("string", () => {}, 100);
      // allow-short-test-timeout:
      test("empty", () => {}, 100);
      // allow-short-test-timeout: runner fixture
      test("allowed", () => {}, 100); // allow-short-test-timeout: runner fixture
      test("still short", () => {}, 100);
    `),
    ).toHaveLength(3);
  });

  let offenders: string[];
  // Follow the other AST lint tests: read and parse each file once in setup,
  // keeping the assertion itself well below the independently enforced budget.
  beforeAll(() => {
    const root = new URL("../../", import.meta.url);
    const files = [
      ...new Bun.Glob("test/**/*.test.ts").scanSync({ cwd: fileURLToPath(root) }),
    ].filter(
      (file) => !file.endsWith(".integration.test.ts") && file !== "test/daemon/manager.test.ts",
    );
    expect(files.length).toBeGreaterThan(0);
    offenders = files.flatMap((file) =>
      shortTimeouts(readFileSync(new URL(file, root), "utf8")).map(
        (violation) => `${file}:${violation}`,
      ),
    );
  }, 20_000);

  test("unit test files contain no short runner deadlines", () => {
    expect(offenders).toEqual([]);
  });
});
