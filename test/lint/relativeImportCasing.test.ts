import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Visitor } from "oxc-parser";
import { parseGuardSource } from "./astGuard";

const ROOT = join(import.meta.dir, "..", "..");
const EXTENSIONS = [".ts", ".tsx", ".js", ".json"];

function relativeSpecifiers(file: string, source: string): string[] {
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
  }).visit(parseGuardSource(file, source));
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
beforeAll(() => {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean),
  );
  failures = [];
  for (const file of tracked) {
    if (!(file.startsWith("src/") || file.startsWith("test/")) || !file.endsWith(".ts")) {
      continue;
    }
    for (const specifier of relativeSpecifiers(file, readFileSync(join(ROOT, file), "utf8"))) {
      if (!resolvesExactly(file, specifier, tracked)) {
        failures.push(`${file} -> ${specifier}`);
      }
    }
  }
});

describe("relative import casing", () => {
  test("every relative module specifier resolves to an exactly cased tracked file", () => {
    expect(failures).toEqual([]);
  });

  test("collects static, type, export, require and nested dynamic imports using the AST", () => {
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
