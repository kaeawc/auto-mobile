import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync, Visitor, type Expression } from "oxc-parser";

// Windows unit lanes reached main red when a test asserted the result of path.join/resolve
// against a literal containing "/": on win32 those helpers return backslash-separated
// paths. Assert with path.join(...) on the expected side, or normalize both sides.
const TEST_DIR = path.join(import.meta.dir, "..");
// Parsing every test file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;
const PATH_FUNCTIONS = new Set(["join", "resolve", "relative", "normalize"]);
const PATH_OBJECTS = new Set(["path", "nodePath", "pathModule", "Path"]);
const EQUALITY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);

// Relative test path -> accepted violation lines. Keep empty while possible.
const ALLOWLIST: Record<string, readonly string[]> = {};

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

function normalizeRelativePath(relative: string): string {
  return relative.split(path.sep).join("/").split("\\").join("/");
}

/** True for `join(...)`, `path.join(...)` and friends; false for `path.posix.*`/`path.win32.*`. */
function isPlatformPathCall(node: Expression): boolean {
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return PATH_FUNCTIONS.has(callee.name);
  }
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    PATH_FUNCTIONS.has(callee.property.name) &&
    callee.object.type === "Identifier" &&
    PATH_OBJECTS.has(callee.object.name)
  );
}

function slashLiteral(node: Expression): boolean {
  if (node.type === "Literal") {
    return typeof node.value === "string" && node.value.includes("/");
  }
  return (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.some((quasi) => quasi.value.raw.includes("/"))
  );
}

/** Lines of `expect(<platform path>).toBe("a/b")` assertions, 1-based. */
export function findPathSeparatorAssertions(source: string): string[] {
  const mentionsAssertions =
    source.includes("expect(") && /join|resolve|relative|normalize/.test(source);
  if (!mentionsAssertions && !source.includes("pathname")) {
    return [];
  }
  const parsed = parseSync("pathSeparator.test.ts", source);
  if (parsed.errors.length > 0) {
    return parsed.errors.map((error) => `parse error: ${error.message}`);
  }
  const pathBindings = new Set<string>();
  // First pass: names bound once to a platform path call. A name that is ever reassigned or
  // redeclared with something else is dropped, so shadowing cannot create a false positive.
  const disqualified = new Set<string>();
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") {
        return;
      }
      if (node.init && isPlatformPathCall(node.init) && !pathBindings.has(node.id.name)) {
        pathBindings.add(node.id.name);
      } else {
        disqualified.add(node.id.name);
      }
    },
    AssignmentExpression(node) {
      if (node.left.type === "Identifier") {
        disqualified.add(node.left.name);
      }
    },
    FunctionDeclaration(node) {
      for (const param of node.params) {
        if (param.type === "Identifier") {
          disqualified.add(param.name);
        }
      }
    },
    ArrowFunctionExpression(node) {
      for (const param of node.params) {
        if (param.type === "Identifier") {
          disqualified.add(param.name);
        }
      }
    },
  }).visit(parsed.program);

  const isPlatformPath = (node: Expression): boolean =>
    isPlatformPathCall(node) ||
    (node.type === "Identifier" && pathBindings.has(node.name) && !disqualified.has(node.name));

  const found: string[] = [];
  new Visitor({
    // `new URL(rel, import.meta.url).pathname` yields "/C:/..." on Windows; use fileURLToPath.
    MemberExpression(node) {
      const base = node.object;
      const anchor = base.type === "NewExpression" ? base.arguments[1] : undefined;
      if (
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "pathname" &&
        base.type === "NewExpression" &&
        base.callee.type === "Identifier" &&
        base.callee.name === "URL" &&
        anchor?.type === "MemberExpression" &&
        anchor.object.type === "MetaProperty" &&
        anchor.property.type === "Identifier" &&
        anchor.property.name === "url"
      ) {
        found.push(`${source.slice(0, node.start).split("\n").length}`);
      }
    },
    CallExpression(node) {
      const matcher = node.callee;
      if (
        matcher.type !== "MemberExpression" ||
        matcher.computed ||
        matcher.property.type !== "Identifier" ||
        !EQUALITY_MATCHERS.has(matcher.property.name)
      ) {
        return;
      }
      const subject = matcher.object;
      const expected = node.arguments[0];
      if (
        subject.type !== "CallExpression" ||
        subject.callee.type !== "Identifier" ||
        subject.callee.name !== "expect" ||
        !expected ||
        expected.type === "SpreadElement"
      ) {
        return;
      }
      const actual = subject.arguments[0];
      if (
        actual &&
        actual.type !== "SpreadElement" &&
        isPlatformPath(actual) &&
        slashLiteral(expected)
      ) {
        found.push(`${source.slice(0, node.start).split("\n").length}`);
      }
    },
  }).visit(parsed.program);
  return found;
}

describe("path separator assertions (Windows unit lane)", () => {
  test.each([
    'expect(path.join(dir, "a")).toBe("/tmp/x/a")',
    'expect(join(dir, "a")).toEqual("a/b")',
    'const p = path.resolve(root, "x"); expect(p).toStrictEqual("/r/x")',
    "expect(path.relative(a, b)).toBe(`sub/file.ts`)",
  ])("flags a platform path compared with a slash literal: %s", (source) => {
    expect(findPathSeparatorAssertions(source)).toEqual(["1"]);
  });

  test("accepts separator-safe comparisons", () => {
    expect(
      findPathSeparatorAssertions(`
      expect(path.join(dir, "a")).toBe(path.join("/tmp/x", "a"));
      expect(path.posix.join("a", "b")).toBe("a/b");
      expect(path.win32.join("a", "b")).toBe("a\\\\b");
      expect(path.join("a")).toBe("a");
      expect(toPosix(path.join(dir, "a"))).toBe("/tmp/x/a");
      expect(path.join(dir, "a").split(path.sep).join("/")).toBe("/tmp/x/a");
      let p = path.join(dir, "a"); p = "x/y"; expect(p).toBe("x/y");
      const q = path.join(dir, "a"); const f = (q) => expect(q).toBe("x/y");
    `),
    ).toEqual([]);
  });

  test("flags URL pathname of import.meta.url but not fileURLToPath", () => {
    expect(
      findPathSeparatorAssertions('const d = new URL("../x/", import.meta.url).pathname'),
    ).toEqual(["1"]);
    expect(
      findPathSeparatorAssertions(
        'const d = fileURLToPath(new URL("../x/", import.meta.url)); d.pathname',
      ),
    ).toEqual([]);
  });

  test("reports syntax errors instead of skipping the file", () => {
    expect(findPathSeparatorAssertions("expect(join(")[0]).toStartWith("parse error:");
  });

  let offenders: string[];
  beforeAll(() => {
    const files = testFiles(TEST_DIR);
    expect(files.length).toBeGreaterThan(0);
    offenders = files.flatMap((file) => {
      const relative = normalizeRelativePath(path.relative(TEST_DIR, file));
      // This guard's own string fixtures intentionally contain forbidden examples.
      if (relative === "lint/pathSeparatorAssertions.test.ts") {
        return [];
      }
      const allowed = ALLOWLIST[relative] ?? [];
      return findPathSeparatorAssertions(readFileSync(file, "utf8"))
        .filter((line) => !allowed.includes(line))
        .map((line) => `test/${relative}:${line}`);
    });
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no test compares a platform path with a slash literal", () => {
    expect(offenders).toEqual([]);
  });
});
