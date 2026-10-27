import { readGuardFile } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";

/**
 * Guard for #11827: the `deviceTools*.ts` handler modules once imported ~100
 * names back from `deviceTools.ts`, which imported their factories. The shared
 * code now lives in `features/deviceLifecycle/deviceLifecycleCore.ts`, a leaf
 * the siblings depend on. This test fails if a RUNTIME import cycle returns
 * among the device and interaction tool modules and their collaborators.
 *
 * Type-only imports are erased at runtime and dynamic `import()` is lazy, so
 * neither forms a load-order cycle; only static value imports/re-exports count.
 */
const ROOT = join(import.meta.dir, "..", "..");
const SERVER_DIR = join(ROOT, "src", "server");

const EXTRA_NODES = [
  "src/server/deviceMutationAdapters.ts",
  "src/features/deviceLifecycle/deviceLifecycleCore.ts",
  "src/features/deviceLifecycle/deviceLifecycleDependencyOverrides.ts",
  "src/server/lifecycleDeviceOwnership.ts",
  "src/daemon/sessionBroker/provisioning/deviceDeleter.ts",
  "src/server/deviceResourceTools.ts",
  "src/server/registerAllTools.ts",
  "src/daemon/socketServer.ts",
  "src/daemon/socketServerParts/ClientRequestCancellation.ts",
  "src/daemon/socketServerParts/DaemonSocketQueueOverflowError.ts",
  "src/daemon/socketServerParts/McpBindings.ts",
  "src/daemon/socketServerParts/McpExecution.ts",
  "src/daemon/socketServerParts/McpRouting.ts",
  "src/daemon/socketServerParts/ReleasedBoundSessionError.ts",
  "src/daemon/socketServerParts/SocketAdmission.ts",
  "src/daemon/socketServerParts/SocketIdeRoutes.ts",
  "src/daemon/socketServerParts/SocketInput.ts",
  "src/daemon/socketServerParts/SocketLifecycle.ts",
  "src/daemon/socketServerParts/SocketServerRuntime.ts",
  "src/daemon/socketServerParts/SocketTextInput.ts",
  "src/daemon/socketServerParts/SocketTransport.ts",
  "src/daemon/socketServerParts/createSocketServerOperations.ts",
  "src/daemon/socketServerParts/socketServerContracts.ts",
  "src/daemon/socketServerParts/socketServerOperations.ts",

  "src/daemon/socketServer/inputDeviceGating.ts",
  "src/daemon/socketServer/inputStrokes.ts",
  "src/daemon/socketServer/inputTypeTextAppendError.ts",
];

function nodeFiles(): string[] {
  const tools = readdirSync(SERVER_DIR)
    .filter((name) => /^deviceTools.*\.ts$/.test(name))
    .map((name) => join("src", "server", name));
  const interaction = [
    "interactionTools.ts",
    "interactionToolHandlers.ts",
    ...readdirSync(join(SERVER_DIR, "interactionTools"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("interactionTools", name)),
  ].map((name) => join("src", "server", name));
  return [...tools, ...interaction, ...EXTRA_NODES].map((p) => join(ROOT, p));
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
  const { body } = parseSync(file, readGuardFile(file)).program;
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

/**
 * Runtime import graph reachable from `roots`. Edges are NOT filtered to the roots: a cycle that
 * leaves the device tool modules through an out-of-scope file (deviceLifecycleCore ->
 * videoRecordingTools -> lifecycleDeviceOwnership -> deviceLifecycleCore) must still be seen.
 */
export function reachableGraph(
  roots: string[],
  importsOf: (file: string) => string[],
): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  const pending = [...roots];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (edges.has(file)) {
      continue;
    }
    const targets = importsOf(file);
    edges.set(file, targets);
    pending.push(...targets);
  }
  return edges;
}

/** First runtime cycle that passes through one of the roots (root ... root). */
export function findCycleThrough(
  roots: string[],
  edges: ReadonlyMap<string, string[]>,
): string[] | undefined {
  for (const root of roots) {
    const seen = new Set<string>();
    const walk = (node: string, trail: string[]): string[] | undefined => {
      for (const next of edges.get(node) ?? []) {
        if (next === root) {
          return [...trail, root];
        }
        if (!seen.has(next)) {
          seen.add(next);
          const found = walk(next, [...trail, next]);
          if (found) {
            return found;
          }
        }
      }
      return undefined;
    };
    const cycle = walk(root, [root]);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

/**
 * Known cycle-closing edges (importer -> imported, repo-relative). Each is removed before the
 * search so a NEW cycle still fails, and each must still close a cycle (shrink-only): delete the
 * entry in the PR that breaks it. Found when the guard stopped filtering edges to in-scope nodes.
 */
const KNOWN_CYCLE_EDGES: ReadonlyArray<readonly [string, string]> = [];

export function withoutEdges(
  edges: ReadonlyMap<string, string[]>,
  removed: ReadonlyArray<readonly [string, string]>,
): Map<string, string[]> {
  return new Map(
    [...edges].map(([from, targets]) => [
      from,
      targets.filter((to) => !removed.some(([a, b]) => a === from && b === to)),
    ]),
  );
}

describe("deviceTools import cycle guard (issue #11827)", () => {
  let nodes: string[];
  let edges: Map<string, string[]>;
  let cycleResult: { cycle: string[] | undefined };
  // Crawling the reachable graph parses many files, so it runs in the hook, not a 100 ms test.
  beforeAll(() => {
    nodes = nodeFiles();
    edges = reachableGraph(nodes, runtimeImports);
    const remaining = withoutEdges(edges, KNOWN_CYCLE_EDGES.map(abs));
    cycleResult = { cycle: findCycleThrough(nodes, remaining) };
  }, 60_000);

  const abs = (edge: readonly [string, string]): [string, string] => [
    join(ROOT, edge[0]),
    join(ROOT, edge[1]),
  ];

  test("no new runtime import cycle through the device or interaction tool modules", () => {
    const { cycle } = cycleResult;
    expect(cycle?.map((f) => relative(ROOT, f))).toBeUndefined();
  });

  test("every known cycle edge still closes a cycle (shrink-only)", () => {
    for (const edge of KNOWN_CYCLE_EDGES) {
      const [from, to] = abs(edge);
      expect(edges.get(from) ?? [], `${edge[0]} no longer imports ${edge[1]}`).toContain(to);
      expect(
        findCycleThrough([from], edges),
        `${edge[0]} -> ${edge[1]} is no longer on a cycle: remove it from KNOWN_CYCLE_EDGES`,
      ).toBeDefined();
    }
  });

  test("a cycle that leaves the in-scope modules is still detected", () => {
    const graph: Record<string, string[]> = {
      core: ["video"],
      video: ["ownership"],
      ownership: ["core"],
      other: [],
    };
    const edges = reachableGraph(["core", "other"], (file) => graph[file] ?? []);
    expect(findCycleThrough(["core", "other"], edges)).toEqual([
      "core",
      "video",
      "ownership",
      "core",
    ]);
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
