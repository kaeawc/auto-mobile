import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";

const ROOT = join(import.meta.dir, "..", "..");
const POLLUTING_SUITE = "test/server/deviceTools.killDevice.test.ts";
const DEVICE_SESSION_REPOSITORY_IMPORT = "../../src/db/deviceSessionRepository";

type AstNode = { type: string } & Record<string, unknown>;

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function stringLiteralValue(value: unknown): string | undefined {
  if (!isAstNode(value) || value.type !== "Literal") {
    return undefined;
  }
  return typeof value.value === "string" ? value.value : undefined;
}

function relativeImports(source: AstNode): string[] {
  const imports: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!isAstNode(value) || seen.has(value)) {
      return;
    }
    seen.add(value);

    let moduleSpecifier: string | undefined;
    if (
      value.type === "ImportDeclaration" ||
      value.type === "ExportNamedDeclaration" ||
      value.type === "ExportAllDeclaration" ||
      value.type === "ImportExpression"
    ) {
      moduleSpecifier = stringLiteralValue(value.source);
    } else if (
      value.type === "CallExpression" &&
      isAstNode(value.callee) &&
      value.callee.type === "Identifier" &&
      value.callee.name === "require" &&
      Array.isArray(value.arguments)
    ) {
      moduleSpecifier = stringLiteralValue(value.arguments[0]);
    }
    if (moduleSpecifier?.startsWith(".")) {
      imports.push(moduleSpecifier);
    }

    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const entry of child) {
          visit(entry);
        }
      } else {
        visit(child);
      }
    }
  };

  visit(source);
  return imports;
}

describe("deviceTools.killDevice import casing (issue #6060)", () => {
  test("uses the repository filename's exact casing", () => {
    const source = parseSync(
      POLLUTING_SUITE,
      readFileSync(join(ROOT, POLLUTING_SUITE), "utf8"),
    ).program;

    const repositoryImports = relativeImports(source).filter(
      (specifier) => specifier.toLowerCase() === DEVICE_SESSION_REPOSITORY_IMPORT.toLowerCase(),
    );

    expect(repositoryImports).toEqual([DEVICE_SESSION_REPOSITORY_IMPORT]);
  });

  test("finds dynamic, require, and export module specifiers throughout a file", () => {
    const source = parseSync(
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
    ).program;

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
