import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const PIPELINE_DIR = path.resolve(import.meta.dir, "../../src/server/pipeline");
const REGISTRY_SPECIFIER = "../toolRegistry";

/**
 * Every module specifier that loads at runtime: value imports and re-exports,
 * side-effect imports, `import x = require()`, dynamic `import()` and `require()`.
 * Type-only declarations are erased and skipped.
 */
function runtimeModuleSpecifiers(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!node.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const [first] = node.arguments;
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first)) {
        specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/**
 * Pipeline stages must be importable on their own: a runtime import of
 * ../toolRegistry forms a cycle (toolRegistry constructs the Default* stages),
 * so importing a stage first throws a TDZ ReferenceError. Type-only imports are
 * erased and safe.
 */
describe("pipeline modules", () => {
  const files = readdirSync(PIPELINE_DIR).filter((f) => f.endsWith(".ts"));

  test("there are pipeline modules to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} has no runtime import of ../toolRegistry`, () => {
      const source = readFileSync(path.join(PIPELINE_DIR, file), "utf8");
      expect(runtimeModuleSpecifiers(file, source)).not.toContain(REGISTRY_SPECIFIER);
    });
  }
});

describe("runtimeModuleSpecifiers", () => {
  test("finds every runtime form and skips type-only ones", () => {
    const source = [
      'import type { A } from "../toolRegistry";',
      'export type { B } from "../toolRegistry";',
      'import { type C } from "./named";',
      'import "./sideEffect";',
      'export { D } from "./reexport";',
      'import E = require("./importEquals");',
      'const f = () => import("./dynamic");',
      'const g = require("./required");',
    ].join("\n");
    expect(runtimeModuleSpecifiers("fixture.ts", source)).toEqual([
      "./named",
      "./sideEffect",
      "./reexport",
      "./importEquals",
      "./dynamic",
      "./required",
    ]);
  });
});
