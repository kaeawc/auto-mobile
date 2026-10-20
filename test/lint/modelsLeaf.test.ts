import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";

import {
  parseGuardSource,
  relativePosix,
  typeScriptFiles,
  readGuardFile,
  GuardVisitor as Visitor,
} from "./astGuard";

/**
 * #11853: src/models is a types-and-pure-functions leaf. It may import only other
 * models, src/constants, and packages. Every other relative import is an edge from
 * the leaf up into services and fails the guard; there is no baseline.
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const MODELS = path.join(ROOT, "src/models");
const ALLOWED_TOP_LEVEL = new Set(["models", "constants"]);

/** Every module specifier a file imports, re-exports or dynamically imports. */
export function moduleSpecifiers(file: string, source: string): string[] {
  const specifiers: string[] = [];
  new Visitor({
    ImportDeclaration(node) {
      specifiers.push(node.source.value);
    },
    ExportAllDeclaration(node) {
      specifiers.push(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source) {
        specifiers.push(node.source.value);
      }
    },
    TSImportType(node) {
      // `import("../x").T` in a type position.
      specifiers.push(node.source.value);
    },
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        specifiers.push(node.source.value);
      }
    },
  }).visit(parseGuardSource(file, source));
  return specifiers;
}

/** Repo-relative target (`src/utils/logger`) when the import leaves the leaf, else undefined. */
export function escapingTarget(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const [root, top] = target.split("/");
  return root === "src" && ALLOWED_TOP_LEVEL.has(top) ? undefined : target;
}

function escapes(files: Map<string, string>): string[] {
  return [...files]
    .flatMap(([file, source]) =>
      moduleSpecifiers(file, source).flatMap((specifier) => {
        const target = escapingTarget(file, specifier);
        return target ? [`${file}\t${target}`] : [];
      }),
    )
    .sort();
}

describe("src/models is a leaf", () => {
  let found: string[];
  // The AST scan runs in the hook so the per-test 100 ms budget is not spent on it.
  beforeAll(() => {
    found = [
      ...new Set(
        escapes(
          new Map(
            typeScriptFiles(MODELS).map((file) => [relativePosix(ROOT, file), readGuardFile(file)]),
          ),
        ),
      ),
    ];
  }, 60_000);

  test("models import only models, constants and packages", () => {
    expect(
      found,
      "src/models may not import services: move the code to its owning directory, or move the shared type into src/models.",
    ).toEqual([]);
  });

  test("classifies specifiers", () => {
    const source = `import a from "./A"; import type { B } from "../utils/B"; export * from "../constants/c";
      export { d } from "../server/d"; import z from "zod"; const e = await import("../daemon/e"); type T = import("../features/t").T;`;
    const targets = moduleSpecifiers("src/models/x.ts", source).map((specifier) =>
      escapingTarget("src/models/x.ts", specifier),
    );
    expect(targets).toEqual([
      undefined,
      "src/utils/B",
      undefined,
      "src/server/d",
      undefined,
      "src/daemon/e",
      "src/features/t",
    ]);
  });
});
