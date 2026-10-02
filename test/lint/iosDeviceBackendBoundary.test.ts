import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const FILES = [
  "src/features/action/LaunchApp.ts",
  "src/features/action/InstallApp.ts",
  "src/features/action/TerminateApp.ts",
  "src/features/action/UninstallApp.ts",
  "src/features/action/ClearAppData.ts",
  "src/features/observe/ListInstalledApps.ts",
  "src/features/observe/GetAppMetadata.ts",
];
const ALLOW_LIST = new Map<string, string>([
  // Deliberate exceptions require a concrete behavior-preservation reason.
]);
const PREDICATES = new Set(["isIosSimulatorUdid", "isIosPhysicalUdid"]);

/** Import specifiers catch aliases and references passed around without a call. */
function udidShapeReferences(source: string): number[] {
  const ast = ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true);
  const violations: number[] = [];
  const namespaces = new Set<string>();
  const record = (node: ts.Node): void => {
    violations.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
  };
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !["iosDeviceType", "iosDeviceType.ts"].includes(
        statement.moduleSpecifier.text.split("/").at(-1) ?? "",
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if (PREDICATES.has((specifier.propertyName ?? specifier.name).text)) {
          record(specifier);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      PREDICATES.has(node.name.text)
    ) {
      record(node);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      ts.isStringLiteral(node.argumentExpression) &&
      PREDICATES.has(node.argumentExpression.text)
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}

// Read and parse each scoped file once, outside per-test timing.
const references = new Map(
  FILES.map((file) => [file, udidShapeReferences(readFileSync(join(ROOT, file), "utf8"))]),
);

describe("iOS app operations use backend kind rather than UDID shape", () => {
  test("scoped call sites contain no unapproved UDID-shape references", () => {
    const offenders = [...references].flatMap(([file, lines]) =>
      ALLOW_LIST.has(file) ? [] : lines.map((line) => `${file}:${line}`),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("every allow-list entry still exists and contains a violation", () => {
    for (const [file, reason] of ALLOW_LIST) {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(references.has(file), file).toBe(true);
      expect(references.get(file)?.length, file).toBeGreaterThan(0);
    }
  });

  test.each([...PREDICATES])("detects imported %s calls and aliases", (predicate) => {
    expect(
      udidShapeReferences(`import { ${predicate} as check } from "./iosDeviceType"; check(id);`),
    ).toEqual([1]);
    expect(
      udidShapeReferences(`import { ${predicate} } from "./iosDeviceType"; ${predicate}(id);`),
    ).toEqual([1]);
    expect(
      udidShapeReferences(`import * as types from "./iosDeviceType"; types.${predicate}(id);`),
    ).toEqual([1]);
    expect(
      udidShapeReferences(`import * as types from "./iosDeviceType"; types["${predicate}"](id);`),
    ).toEqual([1]);
  });

  test("ignores comment and prose mentions", () => {
    expect(
      udidShapeReferences(
        `// isIosSimulatorUdid(id)\n/* isIosPhysicalUdid */\nconst prose = "isIosSimulatorUdid from iosDeviceType";`,
      ),
    ).toEqual([]);
  });
});
