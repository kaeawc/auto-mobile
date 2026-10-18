import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";

/**
 * Guard for #11827: the `deviceTools*.ts` handler modules once imported ~100
 * names back from `deviceTools.ts`, which imported their factories. The shared
 * code now lives in `features/deviceLifecycle/deviceLifecycleCore.ts`, a leaf
 * the siblings depend on. This test fails if a RUNTIME import cycle returns
 * among the device tool modules and the files that share names with them.
 *
 * Type-only imports are erased at runtime and dynamic `import()` is lazy, so
 * neither forms a load-order cycle; only static value imports/re-exports count.
 */
const ROOT = join(import.meta.dir, "..", "..");
const SERVER_DIR = join(ROOT, "src", "server");

const EXTRA_NODES = [
  "src/features/deviceLifecycle/deviceLifecycleCore.ts",
  "src/server/lifecycleDeviceOwnership.ts",
  "src/daemon/sessionBroker/provisioning/deviceDeleter.ts",
  "src/server/deviceResourceTools.ts",
  "src/server/registerAllTools.ts",
  "src/daemon/socketServer.ts",
];

function nodeFiles(): string[] {
  const tools = readdirSync(SERVER_DIR)
    .filter((name) => /^deviceTools.*\.ts$/.test(name))
    .map((name) => join("src", "server", name));
  return [...tools, ...EXTRA_NODES].map((p) => join(ROOT, p));
}

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [`${base}.ts`, join(base, "index.ts")].find(existsSync);
}

interface ImportNode {
  type: string;
  importKind?: string;
  exportKind?: string;
  source?: { value?: unknown } | null;
}

function runtimeImports(file: string): string[] {
  const { body } = parseSync(file, readFileSync(file, "utf8")).program;
  const targets: string[] = [];
  for (const node of body as ImportNode[]) {
    const isImport = node.type === "ImportDeclaration" && node.importKind !== "type";
    const isExport =
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.exportKind !== "type";
    const specifier = node.source?.value;
    if ((isImport || isExport) && typeof specifier === "string" && specifier.startsWith(".")) {
      const target = resolveModule(file, specifier);
      if (target) {
        targets.push(target);
      }
    }
  }
  return targets;
}

function findCycle(nodes: string[], edges: ReadonlyMap<string, string[]>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === "visiting") {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) {
          return cycle;
        }
      }
    }
    stack.pop();
    state.set(node, "done");
    return undefined;
  };
  for (const node of nodes) {
    if (!state.has(node)) {
      const cycle = visit(node);
      if (cycle) {
        return cycle;
      }
    }
  }
  return undefined;
}

describe("deviceTools import cycle guard (issue #11827)", () => {
  test("no runtime import cycle among the device tool modules", () => {
    const nodes = nodeFiles();
    const inScope = new Set(nodes);
    const edges = new Map(nodes.map((n) => [n, runtimeImports(n).filter((t) => inScope.has(t))]));
    const cycle = findCycle(nodes, edges);
    expect(cycle?.map((f) => relative(ROOT, f))).toBeUndefined();
  });

  test("detector reports a cycle and ignores acyclic graphs", () => {
    const edges = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    expect(findCycle(["a", "b", "c"], edges)).toEqual(["a", "b", "c", "a"]);
    expect(
      findCycle(
        ["a", "b"],
        new Map([
          ["a", ["b"]],
          ["b", []],
        ]),
      ),
    ).toBeUndefined();
  });
});
