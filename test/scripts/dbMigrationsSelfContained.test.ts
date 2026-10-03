import { Glob } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix } from "node:path";
import ts from "typescript";
import packageJson from "../../package.json";
import { DB_RUNTIME_FILES } from "../../scripts/build/copy-db-runtime-files";
import { REQUIRED_PACKED_RUNTIME_ASSETS } from "../../scripts/build/packed-runtime-assets";

const migrationsDir = join(import.meta.dir, "../../src/db/migrations");
const migrationFiles = [...new Glob("**/*.ts").scanSync({ cwd: migrationsDir })].sort();
const shippedFiles = new Set<string>([
  ...DB_RUNTIME_FILES,
  ...migrationFiles.map((file) => `migrations/${file.replaceAll("\\", "/")}`),
]);
const dependencies = Object.keys(packageJson.dependencies);

function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

function runtimeModule(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) && !isTypeOnlyImport(node.importClause)) {
    return node.moduleSpecifier;
  }
  if (ts.isExportDeclaration(node) && !isTypeOnlyExport(node)) {
    return node.moduleSpecifier;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    !node.isTypeOnly &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return node.moduleReference.expression;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0];
  }
  return undefined;
}

function isShippedSpecifier(specifier: string, sourcePath: string): boolean {
  if (specifier.startsWith("node:")) {
    return isBuiltin(specifier);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = posix.join(posix.dirname(sourcePath), specifier);
    // Bun resolves extensionless imports and .js specifiers to the raw .ts files.
    const candidates = [resolved, `${resolved}.ts`, posix.join(resolved, "index.ts")];
    if (resolved.endsWith(".js")) {
      candidates.push(`${resolved.slice(0, -3)}.ts`);
    }
    return candidates.some((candidate) => shippedFiles.has(candidate));
  }
  return dependencies.some(
    (dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`),
  );
}

// Pure analyzer: the immutable packaging policy above is shared by fixtures and the repository scan.
function findUnshippedRuntimeImports(
  sourceText: string,
  sourcePath = "migrations/fixture.ts",
): string[] {
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const offending = new Set<string>();
  const visit = (node: ts.Node): void => {
    const module = runtimeModule(node);
    if (module) {
      if (ts.isStringLiteralLike(module)) {
        if (!isShippedSpecifier(module.text, sourcePath)) {
          offending.add(module.text);
        }
      } else {
        // Computed specifiers cannot be verified against the shipped file manifest.
        offending.add(module.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...offending].sort();
}

const cases: [string, string[]][] = [
  ['import { asMigratorDb } from "../migratorSchema";', ["../migratorSchema"]],
  ['import type { X } from "../migratorSchema";', []],
  ['import { type X, type Y } from "../migratorSchema";', []],
  ['import { type X, value } from "../migratorSchema";', ["../migratorSchema"]],
  ['import Default, { type X } from "../x";', ["../x"]],
  ['import * as namespace from "../x";', ["../x"]],
  ['import type * as namespace from "../x";', []],
  ['import "../x";', ["../x"]],
  ['import {} from "../x";', ["../x"]],
  ['import { type Kysely, sql } from "kysely";', []],
  ['import { Migrator } from "kysely/migration";', []],
  ['import { x } from "kysely-unshipped";', ["kysely-unshipped"]],
  ['import ts from "typescript";', ["typescript"]],
  ['import { x } from "@jimp/core/subpath";', []],
  ['import { x } from "@jimp/unshipped";', ["@jimp/unshipped"]],
  ['import { readFileSync } from "node:fs";', []],
  ['import { x } from "node:unshipped";', ["node:unshipped"]],
  ['import { EVENT_TABLES } from "../eventTables";', []],
  ['import { EVENT_TABLES } from "../eventTables.ts";', []],
  ['import { EVENT_TABLES } from "../eventTables.js";', []],
  ['import { x } from "../eventTables/unshipped";', ["../eventTables/unshipped"]],
  ['import { up } from "./2026_01_27_000_failures";', []],
  ['import { up } from "./unshipped";', ["./unshipped"]],
  ['import { x } from "./../../db/migratorSchema";', ["./../../db/migratorSchema"]],
  ['import("../x");', ["../x"]],
  ["import(`../x`);", ["../x"]],
  ['import("../x", { with: { type: "json" } });', ["../x"]],
  ['require("../x");', ["../x"]],
  ['import x = require("../x");', ["../x"]],
  ['import type x = require("../x");', []],
  ['export { a } from "../x";', ["../x"]],
  ['export * from "../x";', ["../x"]],
  ['export * as namespace from "../x";', ["../x"]],
  ['export type { X } from "../x";', []],
  ['export { type X } from "../x";', []],
  ['export { type X, a } from "../x";', ["../x"]],
  ['export type * from "../x";', []],
  ['type X = import("../x").X;', []],
  ["import(target); require(target);", ["target"]],
  ['// import { a } from "../x";\nconst text = \'require("../x")\';', []],
];

describe("raw DB migrations are self-contained", () => {
  let violations: { file: string; specifiers: string[] }[];

  beforeAll(() => {
    // Parse repository fixtures once outside per-test timing; assertions and string self-tests stay fast.
    violations = migrationFiles
      .map((file) => ({
        file,
        specifiers: findUnshippedRuntimeImports(
          readFileSync(join(migrationsDir, file), "utf8"),
          `migrations/${file.replaceAll("\\", "/")}`,
        ),
      }))
      .filter(({ specifiers }) => specifiers.length > 0);
  });

  test.each(cases)("checks runtime dependencies in %s", (source, expected) => {
    expect(findUnshippedRuntimeImports(source)).toEqual(expected);
  });

  test("every migration runtime dependency is shipped", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test("every copied DB runtime file is required in the packed asset manifest", () => {
    expect(DB_RUNTIME_FILES.length).toBeGreaterThan(0);
    for (const file of DB_RUNTIME_FILES) {
      expect(REQUIRED_PACKED_RUNTIME_ASSETS).toContain(`dist/src/db/${file}`);
    }
  });
});
