import { Glob } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix } from "node:path";
import ts from "typescript";
import packageJson from "../../package.json";

// Bundled into dist, devDependency since #12474, and still resolvable by
// AUTOMOBILE_MIGRATIONS_DIR override-folder migrations (see migrationDependencyIntegrity.ts).
const BUNDLED_MIGRATION_RUNTIME_PACKAGES = ["kysely"];
const migrationsDir = join(import.meta.dir, "../../src/db/migrations");
const migrationFiles = [...new Glob("**/*.ts").scanSync({ cwd: migrationsDir })].sort();
const siblingRuntimeFiles = ["eventTables.ts"] as const;
const overrideFolderFiles = new Set<string>([
  ...siblingRuntimeFiles,
  ...migrationFiles.map((file) => `migrations/${file.replaceAll("\\", "/")}`),
]);
const dependencies = [
  ...Object.keys(packageJson.dependencies),
  ...BUNDLED_MIGRATION_RUNTIME_PACKAGES,
];

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

function isAvailableInOverrideFolder(specifier: string, sourcePath: string): boolean {
  if (isBuiltin(specifier)) {
    return true;
  }
  if (specifier.startsWith("node:")) {
    return false;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = posix.join(posix.dirname(sourcePath), specifier);
    // Bun resolves extensionless imports and .js specifiers to the raw .ts files.
    const candidates = [resolved, `${resolved}.ts`, posix.join(resolved, "index.ts")];
    if (resolved.endsWith(".js")) {
      candidates.push(`${resolved.slice(0, -3)}.ts`);
    }
    return candidates.some((candidate) => overrideFolderFiles.has(candidate));
  }
  return dependencies.some(
    (dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`),
  );
}

// Pure analyzer: the override-folder policy above is shared by fixtures and the repository scan.
function findUnprovidedOverrideRuntimeImports(
  sourceText: string,
  sourcePath = "migrations/fixture.ts",
): string[] {
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const offending = new Set<string>();
  const visit = (node: ts.Node): void => {
    const module = runtimeModule(node);
    if (module) {
      if (ts.isStringLiteralLike(module)) {
        if (!isAvailableInOverrideFolder(module.text, sourcePath)) {
          offending.add(module.text);
        }
      } else {
        // Computed specifiers cannot be verified against the override folder file set.
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
  ['import { readFileSync } from "fs";', []],
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

describe("raw DB migration override folder is self-contained", () => {
  let violations: { file: string; specifiers: string[] }[];

  beforeAll(() => {
    // Parse repository fixtures once outside per-test timing; assertions and string self-tests stay fast.
    violations = migrationFiles
      .map((file) => ({
        file,
        specifiers: findUnprovidedOverrideRuntimeImports(
          readFileSync(join(migrationsDir, file), "utf8"),
          `migrations/${file.replaceAll("\\", "/")}`,
        ),
      }))
      .filter(({ specifiers }) => specifiers.length > 0);
  });

  test.each(cases)("checks runtime dependencies in %s", (source, expected) => {
    expect(findUnprovidedOverrideRuntimeImports(source)).toEqual(expected);
  });

  test("every migration runtime dependency is available in the override folder", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test("bundled migration runtime packages are devDependencies", () => {
    for (const dependency of BUNDLED_MIGRATION_RUNTIME_PACKAGES) {
      expect(
        Object.entries(packageJson.devDependencies).find(([name]) => name === dependency)?.[1],
      ).toBeDefined();
    }
  });
});
