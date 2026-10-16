import { parseSync } from "oxc-parser";

/**
 * Finds known-expensive work inside `beforeEach`/`afterEach` hooks of a test file.
 *
 * CI's per-test time (the JUnit reporter's) includes `beforeEach`/`afterEach` and excludes only
 * `beforeAll`/`afterAll`, and a contended 4-core runner stretches filesystem and image work 5-15x.
 * A `mkdtemp` + recursive `rm` pair, an image/zip fixture or a `DevicePool` rebuilt per test is
 * therefore paid inside every test's 100 ms budget. Move it to `beforeAll`/`afterAll` (see
 * `test/helpers/scratchRoot.ts` for temp directories) or share an immutable fixture.
 */
export type ExpensiveHookKind = "temp-dir" | "recursive-rm" | "image-fixture" | "heavy-harness";

export interface ExpensiveHookFinding {
  readonly kind: ExpensiveHookKind;
  readonly hook: "beforeEach" | "afterEach";
  readonly line: number;
}

type AstNode = { type: string } & Record<string, unknown>;

const HOOKS = new Set(["beforeEach", "afterEach"]);
const TEMP_DIR_CALLS = new Set(["mkdtemp", "mkdtempSync"]);
const REMOVE_CALLS = new Set(["rm", "rmSync", "rmdir", "rmdirSync"]);
const IMAGE_CONSTRUCTORS = new Set(["Jimp", "AdmZip"]);
const IMAGE_CALLS = new Set(["createTestImage", "createTestPng"]);
const HARNESS_CONSTRUCTORS = new Set(["DevicePool"]);
const HARNESS_CALLS = new Set(["createRegistryWiredDevicePool", "makePool", "createDevicePoolFor"]);

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function isFunctionNode(node: AstNode): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/** `foo`, `fs.foo` and `fs["foo"]` all name the callee `foo`. */
function calleeName(callee: unknown): string | undefined {
  if (!isAstNode(callee)) {
    return undefined;
  }
  if (callee.type === "Identifier") {
    return callee.name as string;
  }
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  const property = callee.property;
  if (!isAstNode(property)) {
    return undefined;
  }
  if (!callee.computed && property.type === "Identifier") {
    return property.name as string;
  }
  return property.type === "Literal" && typeof property.value === "string"
    ? property.value
    : undefined;
}

function kindOfCall(node: AstNode): ExpensiveHookKind | undefined {
  const name = calleeName(node.callee);
  if (name === undefined) {
    return undefined;
  }
  if (TEMP_DIR_CALLS.has(name)) {
    return "temp-dir";
  }
  if (REMOVE_CALLS.has(name)) {
    return "recursive-rm";
  }
  if (IMAGE_CALLS.has(name)) {
    return "image-fixture";
  }
  return HARNESS_CALLS.has(name) ? "heavy-harness" : undefined;
}

function kindOfNew(node: AstNode): ExpensiveHookKind | undefined {
  const name = calleeName(node.callee);
  if (name === undefined) {
    return undefined;
  }
  if (IMAGE_CONSTRUCTORS.has(name)) {
    return "image-fixture";
  }
  return HARNESS_CONSTRUCTORS.has(name) ? "heavy-harness" : undefined;
}

function children(node: AstNode): AstNode[] {
  const found: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      found.push(...value.filter(isAstNode));
    } else if (isAstNode(value)) {
      found.push(value);
    }
  }
  return found;
}

function collect(root: AstNode, visit: (node: AstNode) => void): void {
  const seen = new WeakSet<object>();
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    visit(node);
    stack.push(...children(node));
  }
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/** Functions a hook can name by reference (`beforeEach(setUp)`), keyed by identifier. */
function namedFunctions(program: AstNode): Map<string, AstNode> {
  const named = new Map<string, AstNode>();
  collect(program, (node) => {
    if (node.type === "FunctionDeclaration" && isAstNode(node.id)) {
      named.set(node.id.name as string, node);
    } else if (
      node.type === "VariableDeclarator" &&
      isAstNode(node.id) &&
      node.id.type === "Identifier" &&
      isAstNode(node.init) &&
      isFunctionNode(node.init)
    ) {
      named.set(node.id.name as string, node.init);
    }
  });
  return named;
}

/** Scan one test file's source. A syntax error is reported as a thrown Error, never swallowed. */
export function scanExpensiveHookWork(file: string, source: string): ExpensiveHookFinding[] {
  if (!/\b(beforeEach|afterEach)\b/.test(source)) {
    return [];
  }
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) {
    throw new Error(`${file}: ${errors[0].message}`);
  }
  const root = program as unknown as AstNode;
  const named = namedFunctions(root);
  const findings: ExpensiveHookFinding[] = [];

  const scanBody = (
    body: AstNode,
    hook: ExpensiveHookFinding["hook"],
    visited: Set<AstNode>,
  ): void => {
    collect(body, (node) => {
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        const kind = node.type === "CallExpression" ? kindOfCall(node) : kindOfNew(node);
        if (kind) {
          findings.push({ kind, hook, line: lineOf(source, node.start as number) });
        }
      }
      if (node.type === "CallExpression" && isAstNode(node.callee)) {
        const callee =
          node.callee.type === "Identifier" ? named.get(node.callee.name as string) : undefined;
        if (callee && !visited.has(callee)) {
          visited.add(callee);
          scanBody(callee, hook, visited);
        }
      }
    });
  };

  collect(root, (node) => {
    if (node.type !== "CallExpression" || !isAstNode(node.callee)) {
      return;
    }
    const name = node.callee.type === "Identifier" ? (node.callee.name as string) : undefined;
    if (!name || !HOOKS.has(name) || !Array.isArray(node.arguments)) {
      return;
    }
    const callback = node.arguments[0];
    const target =
      isAstNode(callback) && callback.type === "Identifier"
        ? named.get(callback.name as string)
        : isAstNode(callback) && isFunctionNode(callback)
          ? callback
          : undefined;
    if (target) {
      scanBody(target, name as ExpensiveHookFinding["hook"], new Set([target]));
    }
  });
  return findings.sort((a, b) => a.line - b.line);
}

/** One stable baseline entry per (file, kind): `path<TAB>kind`. */
export function baselineEntries(file: string, findings: readonly ExpensiveHookFinding[]): string[] {
  return [...new Set(findings.map((finding) => `${file}\t${finding.kind}`))];
}
