import ts from "typescript";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const POLLUTING_SUITE = "test/server/deviceTools.killDevice.test.ts";
const DEVICE_SESSION_REPOSITORY_IMPORT = "../../src/db/deviceSessionRepository";

function relativeImports(source: ts.SourceFile): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    let moduleSpecifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      moduleSpecifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const firstArgument = node.arguments[0];
      if (
        ts.isStringLiteral(firstArgument) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        moduleSpecifier = firstArgument;
      }
    }

    if (
      moduleSpecifier &&
      ts.isStringLiteral(moduleSpecifier) &&
      moduleSpecifier.text.startsWith(".")
    ) {
      imports.push(moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return imports;
}

describe("deviceTools.killDevice import casing (issue #6060)", () => {
  test("uses the repository filename's exact casing", () => {
    const source = ts.createSourceFile(
      POLLUTING_SUITE,
      readFileSync(join(ROOT, POLLUTING_SUITE), "utf8"),
      ts.ScriptTarget.Latest,
      false,
    );

    const repositoryImports = relativeImports(source).filter(
      (specifier) => specifier.toLowerCase() === DEVICE_SESSION_REPOSITORY_IMPORT.toLowerCase(),
    );

    expect(repositoryImports).toEqual([DEVICE_SESSION_REPOSITORY_IMPORT]);
  });

  test("finds dynamic, require, and export module specifiers throughout a file", () => {
    const source = ts.createSourceFile(
      "inline-fixture.ts",
      `
        export async function loadRepo() {
          const dynamic = await import("../../src/db/DeviceSessionRepository");
          const required = require("../../src/db/deviceSessionRepository");
          return dynamic ?? required;
        }
        export { loadRepo } from "../../src/db/deviceSessionRepository";
        const alsoBad = require("../../src/db/DeviceSessionREPOSITORY");
      `,
      ts.ScriptTarget.Latest,
      false,
    );

    const repositoryImports = relativeImports(source);

    expect(repositoryImports).toEqual([
      "../../src/db/DeviceSessionRepository",
      "../../src/db/deviceSessionRepository",
      "../../src/db/deviceSessionRepository",
      "../../src/db/DeviceSessionREPOSITORY",
    ]);
    expect(
      repositoryImports.filter(
        (specifier) =>
          specifier.toLowerCase() === DEVICE_SESSION_REPOSITORY_IMPORT.toLowerCase() &&
          specifier !== DEVICE_SESSION_REPOSITORY_IMPORT,
      ),
    ).toEqual(["../../src/db/DeviceSessionRepository", "../../src/db/DeviceSessionREPOSITORY"]);
  });
});
