import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { dynamicImports, parseSource } from "../helpers/entrypointOrder";

describe("packaged WebRTC runtime metadata", () => {
  // `reflect-metadata` is a side-effect polyfill that `build.ts` inlines into
  // `dist/src/index.js`. These source-level contracts stay in the fast unit
  // lane; the real bundle/subprocess proof lives in the integration companion.
  test("reflect-metadata is a direct dependency available to the build", async () => {
    const pkg = await Bun.file("package.json").json();
    const declaredVersion =
      pkg.dependencies?.["reflect-metadata"] ?? pkg.devDependencies?.["reflect-metadata"];
    expect(declaredVersion).toBeString();
  });

  // `./daemon/processEntry` must precede everything to capture the launcher pid
  // (#11041); it imports nothing, so runtime metadata is still initialized
  // before any module that could depend on it.
  test("the packaged entrypoint initializes runtime metadata first", async () => {
    const entrypoint = await Bun.file("src/index.ts").text();
    expect(leadingImportViolations(entrypoint)).toEqual([]);
  });

  test("the leading-import guard fails when an import is reordered or given bindings", async () => {
    const entrypoint = await Bun.file("src/index.ts").text();
    const swapped = entrypoint
      .replace('import "./daemon/processEntry";', "@@A@@")
      .replace('import "./runtime/reflectMetadata";', 'import "./daemon/processEntry";')
      .replace("@@A@@", 'import "./runtime/reflectMetadata";');
    expect(swapped).not.toBe(entrypoint);
    expect(leadingImportViolations(swapped)).not.toEqual([]);
    const withBindings = entrypoint.replace(
      'import "./runtime/reflectMetadata";',
      'import * as metadata from "./runtime/reflectMetadata";',
    );
    expect(leadingImportViolations(withBindings)).not.toEqual([]);
    const inserted = entrypoint.replace(
      'import "./runtime/bunRuntimeGuard";',
      'import { errorMessage } from "./utils/describeUnknownError";\nimport "./runtime/bunRuntimeGuard";',
    );
    expect(leadingImportViolations(inserted)).not.toEqual([]);
  });

  test("the runtime guard and process entry modules import nothing", async () => {
    for (const path of ["src/runtime/bunRuntimeGuard.ts", "src/daemon/processEntry.ts"]) {
      expect(moduleDependencyViolations(await Bun.file(path).text())).toEqual([]);
    }
  });

  test("the import-nothing guard fails on static, re-export and dynamic dependencies", () => {
    for (const source of [
      'import "./x";\nexport const a = 1;',
      'export * from "./x";',
      'export { a } from "./x";',
      'export const lazy = () => import("./x");',
      'import legacy = require("./x");',
    ]) {
      expect(moduleDependencyViolations(source)).not.toEqual([]);
    }
    expect(moduleDependencyViolations("export const a = 1;")).toEqual([]);
  });

  test("runtime metadata initialization loads reflect-metadata", async () => {
    const runtimeInit = await Bun.file("src/runtime/reflectMetadata.ts").text();
    expect(sideEffectImportSpecifiers(runtimeInit)).toEqual(["reflect-metadata"]);
    expect(parseSource(runtimeInit).statements).toHaveLength(1);
  });
});

/** The first three import statements of the entrypoint, as side-effect imports in this order. */
function leadingImportViolations(source: string): string[] {
  const imports = parseSource(source).statements.filter(ts.isImportDeclaration);
  const expected = [
    "./runtime/bunRuntimeGuard",
    "./daemon/processEntry",
    "./runtime/reflectMetadata",
  ];
  return expected.flatMap((specifier, index) => {
    const declaration = imports[index];
    if (!declaration) {
      return [`missing import ${index} (${specifier})`];
    }
    const actual = ts.isStringLiteral(declaration.moduleSpecifier)
      ? declaration.moduleSpecifier.text
      : declaration.moduleSpecifier.getText();
    if (actual !== specifier) {
      return [`import ${index} is ${actual}, expected ${specifier}`];
    }
    return declaration.importClause ? [`import ${specifier} must be a side-effect import`] : [];
  });
}

function sideEffectImportSpecifiers(source: string): string[] {
  return parseSource(source)
    .statements.filter(ts.isImportDeclaration)
    .filter((declaration) => !declaration.importClause)
    .map((declaration) => (declaration.moduleSpecifier as ts.StringLiteral).text);
}

/** A module that must stay dependency-free: no static, re-export or dynamic imports. */
function moduleDependencyViolations(source: string): string[] {
  const sf = parseSource(source);
  const violations: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      violations.push(`static import ${statement.moduleSpecifier.getText()}`);
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      violations.push(`import-equals ${statement.moduleReference.getText()}`);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      violations.push(`re-export from ${statement.moduleSpecifier.getText()}`);
    }
  }
  for (const call of dynamicImports(sf)) {
    violations.push(`dynamic import ${call.getText()}`);
  }
  return violations;
}
