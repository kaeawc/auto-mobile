import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync, Visitor } from "oxc-parser";

// #11576: the Windows unit lane's largest failure (80 of 132 classified failing jobs over
// 2026-10-09/10, red on main for 15 hours) was one assertion:
//
//   const claim = iosDeviceAllocationClaimPath("ABC-123", {}, "/home/someone");
//   expect(claim.startsWith("/home/someone/.auto-mobile/")).toBe(true);
//
// The test hands a POSIX-absolute directory to the code under test and expects a literal that
// extends it. Code that builds the result with `path.join`/`path.resolve` returns backslashes (and
// a drive letter) on Windows, so the literal can only match on POSIX. Build the expected side with
// the same `path` functions, or pass the actual value through a separator normaliser.
//
// The scan is per test callback: a literal the test passed into a call, and an expected literal
// that starts with it plus "/". Code that concatenates "/" itself (device paths, URLs) never trips
// it unless a test also feeds it such a directory; list those in ALLOWLIST with the reason.
const TEST_DIR = path.join(import.meta.dir, "..");
// Parsing every test file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;
const SELF = "lint/posixPathLiteralExpectations.test.ts";
const POSIX_ABSOLUTE_DIR = /^\/[A-Za-z][\w.-]*(\/[\w.-]+)*$/;
const MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toContain", "toStartWith"]);
/** The actual side went through something that fixes the separator, or is POSIX by construction. */
const SEPARATOR_SAFE = /normali[sz]e|toPosix|posix|replaceAll\(|\.replace\(|\.split\(/;

// Relative test path -> accepted "line: reason". Keep empty while possible.
const ALLOWLIST: Record<string, readonly string[]> = {};

type Node = { type: string; start: number; end: number } & Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function stringLiterals(node: unknown, into: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const entry of node) {
      stringLiterals(entry, into);
    }
  } else if (isNode(node)) {
    if (node.type === "Literal" && typeof node.value === "string") {
      into.push(node);
    } else if (node.type === "ArrayExpression") {
      stringLiterals(node.elements, into);
    } else if (node.type === "ObjectExpression") {
      stringLiterals(node.properties, into);
    } else if (node.type === "Property") {
      stringLiterals(node.value, into);
    }
  }
  return into;
}

function memberName(callee: unknown): string | undefined {
  return isNode(callee) &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isNode(callee.property) &&
    callee.property.type === "Identifier"
    ? (callee.property.name as string)
    : undefined;
}

/** `test(...)`, `it(...)`, `test.only(...)`, `test.each(rows)(...)`. */
function isTestCall(callee: unknown): boolean {
  if (!isNode(callee)) {
    return false;
  }
  if (callee.type === "Identifier") {
    return callee.name === "test" || callee.name === "it";
  }
  if (callee.type === "MemberExpression") {
    return isTestCall(callee.object);
  }
  return callee.type === "CallExpression" && isTestCall(callee.callee);
}

/** The `expect(<actual>)` at the root of a matcher chain (`expect(a).not.toBe(...)`). */
function expectActual(matcherCallee: unknown): Node | undefined {
  let current = isNode(matcherCallee) ? matcherCallee.object : undefined;
  while (isNode(current) && current.type === "MemberExpression") {
    current = current.object;
  }
  if (
    isNode(current) &&
    current.type === "CallExpression" &&
    isNode(current.callee) &&
    current.callee.type === "Identifier" &&
    current.callee.name === "expect"
  ) {
    const actual = (current.arguments as unknown[])[0];
    return isNode(actual) ? actual : undefined;
  }
  return undefined;
}

/** 1-based lines where a test expects a literal extending a POSIX directory it passed in. */
export function findPosixPathLiteralExpectations(source: string): string[] {
  if (!source.includes('"/') && !source.includes("'/") && !source.includes("`/")) {
    return [];
  }
  const parsed = parseSync("posixPathLiteral.test.ts", source);
  if (parsed.errors.length > 0) {
    return parsed.errors.map((error) => `parse error: ${error.message}`);
  }
  const text = (node: Node) => source.slice(node.start, node.end);
  const lineOf = (node: Node) => `${source.slice(0, node.start).split("\n").length}`;
  const found = new Set<string>();

  /** POSIX-absolute directory literals handed to a call anywhere inside `node`. */
  const directoryArguments = (node: Node): string[] => {
    const directories: string[] = [];
    // A plain walk: the expression may be any node kind (a call, an await, a member chain).
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (isNode(value)) {
        if (value.type === "CallExpression") {
          for (const literal of stringLiterals(value.arguments)) {
            if (POSIX_ABSOLUTE_DIR.test(literal.value as string)) {
              directories.push(literal.value as string);
            }
          }
        }
        Object.values(value).forEach(walk);
      }
    };
    walk(node);
    return directories;
  };

  const scanTest = (body: Node): void => {
    const initializers = new Map<string, Node>();
    const expectations: Array<{ literal: Node; actual: Node }> = [];
    new Visitor({
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init) {
          initializers.set(node.id.name, node.init as unknown as Node);
        }
      },
      CallExpression(node) {
        const name = memberName(node.callee);
        const matcherActual =
          name !== undefined && MATCHERS.has(name) ? expectActual(node.callee) : undefined;
        if (matcherActual) {
          for (const literal of stringLiterals(node.arguments)) {
            expectations.push({ literal, actual: matcherActual });
          }
          return;
        }
        const callee = node.callee as unknown as Node;
        if (name === "startsWith" && isNode(callee.object)) {
          for (const literal of stringLiterals(node.arguments)) {
            expectations.push({ literal, actual: callee.object });
          }
        }
      },
    }).visit(body as never);

    for (const { literal, actual } of expectations) {
      // The value under test: the asserted expression, plus what its variable was built from.
      // `file.path`, `found[0]` and `[...found]` are read back to the variable `file`/`found`.
      let root: unknown = actual;
      while (isNode(root) && root.type !== "Identifier") {
        root =
          root.type === "MemberExpression"
            ? root.object
            : root.type === "ArrayExpression" && (root.elements as unknown[]).length === 1
              ? (root.elements as unknown[])[0]
              : root.type === "SpreadElement"
                ? root.argument
                : undefined;
      }
      const initializer = isNode(root) ? initializers.get(root.name as string) : undefined;
      const sources = initializer ? [actual, initializer] : [actual];
      if (sources.some((node) => SEPARATOR_SAFE.test(text(node)))) {
        continue;
      }
      const value = literal.value as string;
      const directories = sources.flatMap(directoryArguments);
      if (directories.some((directory) => value.startsWith(`${directory}/`))) {
        found.add(lineOf(literal));
      }
    }
  };

  new Visitor({
    CallExpression(node) {
      if (!isTestCall(node.callee)) {
        return;
      }
      const body = node.arguments.findLast(
        (argument) =>
          argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression",
      );
      if (body) {
        scanTest(body as unknown as Node);
      }
    },
  }).visit(parsed.program);
  return [...found];
}

describe("POSIX path literal expectations (Windows unit lane, #11576)", () => {
  test.each([
    // The assertion that kept main red on Windows for 15 hours.
    `test("claims", () => {
      const claim = iosDeviceAllocationClaimPath("ABC-123", {}, "/home/someone");
      expect(claim.startsWith("/home/someone/.auto-mobile/")).toBe(true);
    });`,
    `it("lists", () => {
      const found = listPidFiles({ dir: "/tmp" });
      expect(found).toEqual(["/tmp/auto-mobile-daemon-1000.pid"]);
    });`,
    `test("awaited", async () => {
      const file = await writeReport({ dir: "/var/reports" });
      expect(file.path).toBe("/var/reports/latest.json");
    });`,
    `test.each([1])("resolves %s", () => {
      expect(defaultPath({}, "/home/agent")).not.toBe("/home/agent/.auto-mobile/slots.sqlite");
    });`,
  ])("flags a literal that extends a directory the test passed in: %s", (source) => {
    expect(findPosixPathLiteralExpectations(source)).toHaveLength(1);
  });

  test("accepts expectations built with path functions or normalised first", () => {
    expect(
      findPosixPathLiteralExpectations(`
      test("a", () => {
        const claim = iosDeviceAllocationClaimPath("ABC-123", {}, "/home/someone");
        expect(claim.startsWith(resolve("/home/someone", ".auto-mobile") + sep)).toBe(true);
        expect(defaultPath({}, "/home/agent")).toBe(path.resolve("/home/agent", ".auto-mobile"));
      });
      test("b", () => {
        const paths = sdkPaths(homeAt("/home/testuser")).map(normalizePath);
        expect(paths).toContain("/home/testuser/Android/Sdk");
        expect(trace(run("/data")).replaceAll("\\\\", "/")).toContain("/data/journal.jsonl");
      });
      test("c", () => {
        // The literal was never handed to the code under test as a directory.
        expect(remotePath(device)).toBe("/sdcard/Download/a.png");
      });
      test("d", () => { use("/home/one"); });
      test("e", () => { expect(other()).toBe("/home/one/file"); });
    `),
    ).toEqual([]);
  });

  test("reports syntax errors instead of skipping the file", () => {
    expect(findPosixPathLiteralExpectations('test("/x", (')[0]).toStartWith("parse error:");
  });

  let offenders: string[];
  let scanned: number;
  beforeAll(() => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(file) : entry.name.endsWith(".test.ts") ? [file] : [];
      });
    const files = walk(TEST_DIR);
    scanned = files.length;
    offenders = files.flatMap((file) => {
      const relative = path.relative(TEST_DIR, file).split(path.sep).join("/");
      // This guard's own string fixtures contain the forbidden examples.
      if (relative === SELF) {
        return [];
      }
      const allowed = (ALLOWLIST[relative] ?? []).map((entry) => entry.split(":")[0]);
      return findPosixPathLiteralExpectations(readFileSync(file, "utf8"))
        .filter((line) => !allowed.includes(line))
        .map((line) => `test/${relative}:${line}`);
    });
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no test expects a POSIX literal that extends a directory it passed in", () => {
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
