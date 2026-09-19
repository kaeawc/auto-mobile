import ts from "typescript";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const POLLUTING_SUITE = "test/server/deviceTools.killDevice.test.ts";
const DEVICE_SESSION_REPOSITORY_IMPORT = "../../src/db/deviceSessionRepository";

function relativeImports(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".")
    ) {
      return [];
    }
    return [statement.moduleSpecifier.text];
  });
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
});
