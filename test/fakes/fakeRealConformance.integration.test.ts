import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Every fake must declare its narrowest production contract. The TypeScript
 * compiler then catches method/signature drift, while this AST check prevents a
 * new fake from omitting the `implements` clause entirely (issue #4439).
 */
const FAKES_DIR = path.join(import.meta.dir);
const EXPECTED_CONTRACT_TYPES: Record<string, string> = {
  "FakeAdbClient.ts:FakeAdbClient": "AdbExecutor",
  "FakeDeviceSnapshotConfigRepository.ts:FakeDeviceSnapshotConfigRepository": "ConfigRepository",
  "FakeDeviceSnapshotRepository.ts:FakeDeviceSnapshotRepository": "DeviceSnapshotRepository",
  "FakeDeviceSnapshotStore.ts:FakeDeviceSnapshotStore": "DeviceSnapshotStore",
  "FakeHighlightClient.ts:FakeHighlightClient": "VisualHighlightClient",
  "FakeNetServer.ts:FakeSocket": "Socket",
  "FakeSetUIStateDependencies.ts:FakeFieldTypeDetector": "FieldTypeDetector",
  "FakeSimCtlClient.ts:FakeSimCtlClient": "SimCtl",
  "FakeTalkBackTapStrategy.ts:FakeTalkBackTapStrategy": "TalkBackTapStrategy",
  "FakeVideoRecordingConfigRepository.ts:FakeVideoRecordingConfigRepository": "ConfigRepository",
  "FakeVideoRecordingRepository.ts:FakeVideoRecordingRepository": "VideoRecordingRepository",
  "FakeWebSocket.ts:FakeWebSocket": "WebSocket",
};

function exportedFakeClassesWithoutContracts(fileName: string): Array<{
  name: string;
  hasContract: boolean;
  contractTypes: string[];
}> {
  const source = ts.createSourceFile(
    fileName,
    readFileSync(path.join(FAKES_DIR, fileName), "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const aliases = new Map<string, ts.TypeNode>();
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      aliases.set(statement.name.text, statement.type);
    }
  }
  const classes: Array<{
    name: string;
    hasContract: boolean;
    contractTypes: string[];
  }> = [];

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) {
      continue;
    }
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    const hasContract =
      statement.heritageClauses?.some(
        (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword,
      ) ?? false;
    if (isExported && statement.name.text.startsWith("Fake")) {
      const contractTypes: string[] = [];
      const visitedAliases = new Set<string>();
      const visitTypeName = (name: string): void => {
        contractTypes.push(name);
        const alias = aliases.get(name);
        if (alias && !visitedAliases.has(name)) {
          visitedAliases.add(name);
          visit(alias);
        }
      };
      const visit = (node: ts.Node): void => {
        if (ts.isTypeReferenceNode(node)) {
          visitTypeName(node.typeName.getText(source));
        }
        if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) {
          visitTypeName(node.expression.text);
        }
        ts.forEachChild(node, visit);
      };
      for (const clause of statement.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
          continue;
        }
        for (const type of clause.types) {
          visit(type);
        }
      }
      classes.push({
        name: `${fileName}:${statement.name.text}`,
        hasContract,
        contractTypes,
      });
    }
  }

  return classes;
}

describe("fake contract conformance (#4439)", () => {
  test("every exported fake declares its compile-time contract", () => {
    const classes = readdirSync(FAKES_DIR)
      .filter((fileName) => fileName.endsWith(".ts") && !fileName.endsWith(".test.ts"))
      .flatMap(exportedFakeClassesWithoutContracts)
      .sort((left, right) => left.name.localeCompare(right.name));
    const missing = classes
      .filter((fakeClass) => !fakeClass.hasContract)
      .map((fakeClass) => fakeClass.name);
    const expectedClasses = classes.filter((fakeClass) =>
      Object.hasOwn(EXPECTED_CONTRACT_TYPES, fakeClass.name),
    );

    expect(missing).toEqual([]);
    expect(expectedClasses.map((fakeClass) => fakeClass.name)).toEqual(
      Object.keys(EXPECTED_CONTRACT_TYPES).sort(),
    );
    for (const fakeClass of expectedClasses) {
      expect(fakeClass.contractTypes).toContain(EXPECTED_CONTRACT_TYPES[fakeClass.name]!);
    }
  });
});
