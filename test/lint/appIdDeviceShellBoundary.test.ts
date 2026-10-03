import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");

const GUARDED_FILES = [
  "src/features/action/LaunchApp.ts",
  "src/features/action/ClearAppData.ts",
  "src/features/action/TerminateApp.ts",
  "src/features/action/UninstallApp.ts",
  "src/features/action/InstallApp.ts",
  "src/features/action/RestoreSnapshot.ts",
  "src/features/database/DatabaseInspector.ts",
  "src/utils/ContentHashProvider.ts",
  "src/ctrlProxy/CtrlProxyManager.ts",
  "src/utils/AppLifecycleMonitor.ts",
  "src/features/utility/DeepLinkManager.ts",
  "src/server/systemTrayHelpers.ts",
  "src/features/utility/PostNotification.ts",
  "src/features/memory/MemoryMetricsCollector.ts",
  "src/features/performance/PerformanceAudit.ts",
  "src/features/performance/PerformanceMonitor.ts",
  "src/features/performance/TouchLatencyTracker.ts",
  "src/features/observe/GetAppMetadata.ts",
  "src/features/observe/AwaitIdle.ts",
  "src/features/observe/Idle.ts",
] as const;

const SENSITIVE_NAMES = new Set([
  "packageName",
  "appId",
  "pid",
  "uri",
  "packageId",
  "apkPath",
  "resolvedPid",
  "device.packageName",
]);

function propertyName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const left = propertyName(node.expression);
    return left === undefined ? undefined : `${left}.${node.name.text}`;
  }
  return undefined;
}

function isShellQuoteCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "shellQuote"
  );
}

function isSensitiveNameReference(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  const name = propertyName(node);
  return name !== undefined && (SENSITIVE_NAMES.has(name) || aliases.has(name));
}

function containsUnquotedSensitiveReference(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  if (isShellQuoteCall(node)) {
    return false;
  }

  const name = propertyName(node);
  if (isSensitiveNameReference(node, aliases)) {
    return true;
  }
  if (name !== undefined && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))) {
    return false;
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsUnquotedSensitiveReference(child, aliases)) {
      found = true;
    }
  });
  return found;
}

function templateLiteralText(node: ts.TemplateExpression): string {
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("");
}

function findOffenses(file: string, sourceText = readFileSync(join(ROOT, file), "utf8")): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const offenses: string[] = [];

  const visit = (node: ts.Node, aliases: Set<string>): void => {
    const localAliases = ts.isSourceFile(node) || ts.isBlock(node) ? new Set(aliases) : aliases;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent)
    ) {
      const isBlockScoped = (node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0;
      if (isBlockScoped) {
        localAliases.delete(node.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0 &&
      node.initializer &&
      (ts.isIdentifier(node.initializer) || ts.isPropertyAccessExpression(node.initializer)) &&
      isSensitiveNameReference(node.initializer, localAliases)
    ) {
      localAliases.add(node.name.text);
    }
    const literalText = ts.isTemplateExpression(node) ? templateLiteralText(node) : "";
    if (
      ts.isTemplateExpression(node) &&
      (literalText.startsWith("shell ") || literalText.startsWith('shell "')) &&
      node.templateSpans.some((span) =>
        containsUnquotedSensitiveReference(span.expression, localAliases),
      )
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      offenses.push(`${file}:${line + 1} ${node.getText(sourceFile)}`);
    }
    ts.forEachChild(node, (child) => visit(child, localAliases));
  };

  visit(sourceFile, new Set());
  return offenses;
}

const offenses = GUARDED_FILES.flatMap((file) => findOffenses(file));

describe("package-scoped Android device-shell boundary", () => {
  test("flags transitive aliases of sensitive identifiers in shell commands", () => {
    const fixture =
      "const x = packageName; const alias = x; const command = `shell echo ${alias}`;";
    expect(findOffenses("alias-fixture.ts", fixture)).toHaveLength(1);
  });
  test("requires shellQuote at every guarded command sink", () => {
    expect(offenses, offenses.join("\n")).toEqual([]);
  });
});
