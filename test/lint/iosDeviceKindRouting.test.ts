import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const RESOLVER = "src/utils/ios-cmdline-tools/IosDeviceKind.ts";
const PREDICATE = "isIosSimulatorUdid";
const ALLOW_LIST = new Map<string, string>([
  [RESOLVER, "canonical device kind resolver"],
  ["src/utils/ios-cmdline-tools/iosDeviceType.ts", "UDID predicate definition"],
  [
    "src/features/debug/VisualHighlight.ts",
    "pre-existing highlight transport routing; migrate in follow-up",
  ],
  [
    "src/features/observe/ObservationDisplay.ts",
    "pre-existing display capability gate; migrate in follow-up",
  ],
  [
    "src/features/observe/ObserveScreen.ts",
    "pre-existing observation routing; migrate in follow-up",
  ],
  [
    "src/features/observe/TakeScreenshot.ts",
    "pre-existing screenshot routing; migrate in follow-up",
  ],
  [
    "src/features/observe/ios/IOSCtrlProxyClient.ts",
    "pre-existing observation client capability gate; migrate in follow-up",
  ],
  ["src/features/webrtc/IosH264Source.ts", "pre-existing capture routing; migrate in follow-up"],
  [
    "src/features/webrtc/h264CaptureSourceFactory.ts",
    "pre-existing capture audio capability gate; migrate in follow-up",
  ],
  [
    "src/utils/ios-cmdline-tools/DevicectlDeviceLister.ts",
    "device discovery and UDID classification, outside backend routing",
  ],
  [
    "src/utils/ios-cmdline-tools/SimCtlClient.ts",
    "simctl error classification, outside backend routing",
  ],
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return sourceFiles(file);
    }
    return entry.isFile() && file.endsWith(".ts") && !file.endsWith(".d.ts") ? [file] : [];
  });
}

/** Identifiers cover imports (including aliases), calls, definitions and property access. */
function udidShapeReferences(ast: ts.SourceFile, root: ts.Node = ast): number[] {
  const lines: number[] = [];
  const namespaces = new Set<string>();
  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      ["iosDeviceType", "iosDeviceType.ts"].includes(
        statement.moduleSpecifier.text.split("/").at(-1) ?? "",
      )
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      (ts.isIdentifier(node) && node.text === PREDICATE) ||
      (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === PREDICATE)
    ) {
      lines.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return lines;
}

// Read and parse every source file once outside per-test timing; retain only reference lines.
const resolverReferencesOutsideKind: number[] = [];
let resolverKindCalls = 0;
const references = new Map(
  sourceFiles("src").map((file) => {
    const ast = ts.createSourceFile(
      file,
      readFileSync(join(ROOT, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    if (file === RESOLVER) {
      for (const statement of ast.statements) {
        if (ts.isImportDeclaration(statement)) {
          continue;
        }
        const lines = udidShapeReferences(ast, statement);
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name?.text === "resolveIosDeviceKind"
        ) {
          resolverKindCalls += lines.length;
        } else {
          resolverReferencesOutsideKind.push(...lines);
        }
      }
    }
    return [file, udidShapeReferences(ast)] as const;
  }),
);

function fixtureReferences(source: string): number[] {
  return udidShapeReferences(
    ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true),
  );
}

describe("iOS device kind routing ratchet", () => {
  test("source files contain no unapproved simulator UDID references", () => {
    const offenders = [...references].flatMap(([file, lines]) =>
      ALLOW_LIST.has(file) ? [] : lines.map((line) => `${file}:${line}`),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("every allow-list entry has a reason and still references the predicate", () => {
    for (const [file, reason] of ALLOW_LIST) {
      expect(reason.trim().length, file).toBeGreaterThan(0);
      expect(references.has(file), file).toBe(true);
      expect(references.get(file)?.length, file).toBeGreaterThan(0);
    }
  });

  test("only the canonical kind resolver references the predicate in its file", () => {
    expect(resolverReferencesOutsideKind).toEqual([]);
    expect(resolverKindCalls).toBe(1);
  });

  test.each([
    `import { isIosSimulatorUdid as check } from "./iosDeviceType"; check(id);`,
    `isIosSimulatorUdid(id);`,
    `import * as types from "./iosDeviceType"; types.isIosSimulatorUdid(id);`,
    `import * as types from "./iosDeviceType.ts"; types["isIosSimulatorUdid"](id);`,
  ])("detects predicate references in %s", (source) => {
    expect(fixtureReferences(source)).toEqual([1]);
  });

  test("ignores comment and prose mentions", () => {
    expect(
      fixtureReferences(
        `// isIosSimulatorUdid(id)\n/* isIosSimulatorUdid */\nconst prose = "isIosSimulatorUdid";`,
      ),
    ).toEqual([]);
  });
});
