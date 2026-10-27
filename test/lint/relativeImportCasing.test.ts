import { beforeAll, describe, expect, test } from "bun:test";
import { join, posix } from "node:path";
import { parseSync } from "oxc-parser";
import { readGuardFile, guardTextMayMatch, GuardVisitor as Visitor } from "./astGuard";
import { workingTreeFiles } from "../helpers/workingTreeFiles";

const ROOT = join(import.meta.dir, "..", "..");
const EXTENSIONS = [".ts", ".tsx", ".js", ".json"];
const SCAN_TIMEOUT_MS = 60_000;

function relativeSpecifiers(file: string, source: string): string[] {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    throw new Error(`${file}: ${parsed.errors[0].message}`);
  }
  const module = parsed.module;
  // The module table owns static import/export requests. Extra tokens may be type/dynamic
  // imports or empty re-exports (which Oxc omits from this table). Those keep the AST path.
  // Comments/strings can only cause a conservative fallback. Escaped names fall back too.
  if (
    !guardTextMayMatch(source, /\brequire\b/) &&
    (source.match(/\bimport\b/g)?.length ?? 0) === module.staticImports.length &&
    (source.match(/\bexport\b/g)?.length ?? 0) ===
      new Set(module.staticExports.map((entry) => entry.start)).size
  ) {
    const requests = [
      ...module.staticImports.map((entry) => entry.moduleRequest),
      ...module.staticExports.flatMap((entry) =>
        entry.entries.flatMap((binding) => (binding.moduleRequest ? [binding.moduleRequest] : [])),
      ),
    ];
    // Each exported binding repeats the request; keep one per declaration in source order.
    return [...new Map(requests.map((request) => [request.start, request])).values()]
      .sort((a, b) => a.start - b.start)
      .map((request) => request.value)
      .filter((value) => value.startsWith("./") || value.startsWith("../"));
  }
  const specifiers: string[] = [];
  const collect = (value: string): void => {
    if (value.startsWith("./") || value.startsWith("../")) {
      specifiers.push(value);
    }
  };
  new Visitor({
    ImportDeclaration: (node) => collect(node.source.value),
    TSImportType: (node) => collect(node.source.value),
    TSExternalModuleReference: (node) => collect(node.expression.value),
    ExportNamedDeclaration: (node) => {
      if (node.source) {
        collect(node.source.value);
      }
    },
    ExportAllDeclaration: (node) => collect(node.source.value),
    ImportExpression: (node) => {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        collect(node.source.value);
      }
    },
    CallExpression: (node) => {
      if (node.callee.type === "Identifier" && node.callee.name === "require") {
        const argument = node.arguments[0];
        if (argument?.type === "Literal" && typeof argument.value === "string") {
          collect(argument.value);
        }
      }
    },
  }).visit(parsed.program);
  return specifiers;
}

function resolvesExactly(file: string, specifier: string, tracked: ReadonlySet<string>): boolean {
  // Bun uses query/fragment suffixes to distinguish module instances, not filenames.
  let modulePath = specifier;
  for (const separator of ["?", "#"]) {
    modulePath = modulePath.split(separator, 1)[0];
  }
  const target = posix.join(posix.dirname(file), modulePath);
  return [
    target,
    ...EXTENSIONS.map((extension) => `${target}${extension}`),
    ...EXTENSIONS.map((extension) => `${target}/index${extension}`),
  ].some((candidate) => tracked.has(candidate));
}

let failures: string[];
// Like the other tree-wide guards, reading/parsing belongs in setup, outside the per-test budget.
// Full-tree parsing can be slow under CI contention; hook time is excluded from the 100ms per-test budget.
beforeAll(() => {
  // Untracked new files count, so a lane need not `git add` (or jj stage) before this runs.
  const tracked = new Set(workingTreeFiles(ROOT));
  failures = [];
  const normalizedTracked = new Set([...tracked].map((file) => file.replaceAll("\\", "/")));
  for (const file of normalizedTracked) {
    if (!(file.startsWith("src/") || file.startsWith("test/")) || !file.endsWith(".ts")) {
      continue;
    }
    const source = readGuardFile(join(ROOT, file));
    if (!['"./', "'./", '"../', "'../", "`./", "`../"].some((prefix) => source.includes(prefix))) {
      continue;
    }
    for (const specifier of relativeSpecifiers(file, source)) {
      if (!resolvesExactly(file, specifier, normalizedTracked)) {
        failures.push(`${file} -> ${specifier}`);
      }
    }
  }
}, SCAN_TIMEOUT_MS);

describe("relative import casing", () => {
  test("every relative module specifier resolves to an exactly cased tracked file", () => {
    expect(failures).toEqual([]);
  });

  test("collects static, type, export, require and nested dynamic imports using the AST", () => {
    expect(
      relativeSpecifiers("fixture.ts", 'import a from "./a"; import type { B } from "../b";'),
    ).toEqual(["./a", "../b"]);
    expect(relativeSpecifiers("fixture.ts", 'type A = import /* ; */ ("./type").A;')).toEqual([
      "./type",
    ]);
    expect(relativeSpecifiers("fixture.ts", 'export {} from "./empty";')).toEqual(["./empty"]);
    expect(
      relativeSpecifiers(
        "fixture.ts",
        'export {a, b} from "./x"; import c from "../c"; export * as d from "./x"; export type {T} from "./t";',
      ),
    ).toEqual(["./x", "../c", "./x", "./t"]);
    expect(
      relativeSpecifiers(
        "fixture.ts",
        `import value from "./value";
         import type { Type } from "./type";
         export { value } from "./named";
         export * from "./all";
         async function load() { return [require("../required"), await import("./dynamic")]; }
         type Imported = import("./import-type").Type;
         import required = require("./import-equals");
         import external from "external";
         const text = 'import("./not-code")';`,
      ),
    ).toEqual([
      "./value",
      "./type",
      "./named",
      "./all",
      "../required",
      "./dynamic",
      "./import-type",
      "./import-equals",
    ]);
  });

  test("checks exact files, extensions, index modules and every directory component", () => {
    const tracked = new Set([
      "src/server/resourceRegistry.ts",
      "src/tools/index.tsx",
      "src/data.json",
      "src/bridge.js",
    ]);
    for (const specifier of [
      "../server/resourceRegistry",
      "../server/resourceRegistry.ts",
      "../tools",
      "../data",
      "../bridge",
      "../data.json?fresh#instance",
    ]) {
      expect(resolvesExactly("src/example/test.ts", specifier, tracked)).toBe(true);
    }
    for (const specifier of [
      "../Server/resourceRegistry",
      "../server/ResourceRegistry",
      "../Tools",
      "../missing",
    ]) {
      expect(resolvesExactly("src/example/test.ts", specifier, tracked)).toBe(false);
    }
  });
});
