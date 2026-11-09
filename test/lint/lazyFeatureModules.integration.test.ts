import { readGuardFile } from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";

/**
 * Guard for #17709: feature-gated modules stay off the startup path. Startup imports every module
 * that `src/startup/serverModules.ts` (and the entry modules before it) names with `import()`, so
 * those are the roots; from them only static value imports and re-exports load at startup.
 * Type-only imports are erased and a nested `import()` waits for first use, so neither counts.
 */
const ROOT = join(import.meta.dir, "..", "..");

const STARTUP_ENTRIES = [
  "src/index.ts",
  "src/startup/serverEntry.ts",
  "src/startup/serverModules.ts",
];

/** Modules each deferred feature loads on its first use, never at startup. */
const DEFERRED_MODULES = [
  "src/server/prototypeTools/runtime.ts",
  "src/server/prototypeResourceReaders.ts",
  "src/vision/ClaudeVisionClient.ts",
  "src/daemon/socketServer/loopbackMcpClient.ts",
  "src/daemon/webrtcStreamManager.ts",
];

/** Packages only those deferred modules import. */
const DEFERRED_PACKAGES = ["@anthropic-ai/sdk", "@modelcontextprotocol/client", "werift"];

interface ModuleNode {
  type: string;
  importKind?: string;
  exportKind?: string;
  source?: { type?: string; value?: unknown } | null;
}

function resolveModule(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [`${base}.ts`, join(base, "index.ts")].find(existsSync);
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

interface ModuleImports {
  readonly staticSpecifiers: string[];
  readonly dynamicSpecifiers: string[];
}

function moduleImports(file: string): ModuleImports {
  const { program } = parseSync(file, readGuardFile(file));
  const staticSpecifiers: string[] = [];
  for (const node of program.body as ModuleNode[]) {
    const isImport = node.type === "ImportDeclaration" && node.importKind !== "type";
    const isExport =
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.exportKind !== "type";
    const specifier = node.source?.value;
    if ((isImport || isExport) && typeof specifier === "string") {
      staticSpecifiers.push(specifier);
    }
  }
  const dynamicSpecifiers: string[] = [];
  collectDynamicImports(program, dynamicSpecifiers);
  return { staticSpecifiers, dynamicSpecifiers };
}

/** Every `import("literal")` anywhere in the tree. */
function collectDynamicImports(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collectDynamicImports(child, into));
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  const source = record.source as ModuleNode["source"];
  if (record.type === "ImportExpression" && typeof source?.value === "string") {
    into.push(source.value);
  }
  Object.values(record).forEach((child) => collectDynamicImports(child, into));
}

interface StartupClosure {
  readonly modules: Set<string>;
  readonly packages: Map<string, string>;
}

function startupClosure(): StartupClosure {
  const entries = STARTUP_ENTRIES.map((entry) => join(ROOT, entry));
  const roots = entries.flatMap((entry) =>
    moduleImports(entry)
      .dynamicSpecifiers.filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolveModule(entry, specifier))
      .filter((target): target is string => target !== undefined),
  );
  const modules = new Set<string>();
  const packages = new Map<string, string>();
  const pending = [...entries, ...roots];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (modules.has(file)) {
      continue;
    }
    modules.add(file);
    for (const specifier of moduleImports(file).staticSpecifiers) {
      if (specifier.startsWith(".")) {
        const target = resolveModule(file, specifier);
        if (target) {
          pending.push(target);
        }
      } else if (!specifier.startsWith("node:") && !specifier.startsWith("bun:")) {
        packages.set(packageName(specifier), relative(ROOT, file));
      }
    }
  }
  return { modules, packages };
}

describe("feature-gated modules load on first use (#17709)", () => {
  let closure: StartupClosure;
  beforeAll(() => {
    closure = startupClosure();
  });

  test("the walk reaches the server and the daemon, so an empty closure cannot pass", () => {
    expect(closure.modules.has(join(ROOT, "src/server/registerAllTools.ts"))).toBe(true);
    expect(closure.modules.has(join(ROOT, "src/daemon/inProcessMcpDispatcher.ts"))).toBe(true);
    expect(closure.packages.has("@modelcontextprotocol/server")).toBe(true);
  });

  test("no deferred module is a static import of the startup path", () => {
    const loaded = DEFERRED_MODULES.filter((module) => closure.modules.has(join(ROOT, module)));
    expect(loaded).toEqual([]);
  });

  test("no deferred package is a static import of the startup path", () => {
    const loaded = DEFERRED_PACKAGES.filter((name) => closure.packages.has(name)).map(
      (name) => `${name} (from ${closure.packages.get(name)})`,
    );
    expect(loaded).toEqual([]);
  });
});
