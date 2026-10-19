import ts from "typescript";

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);

/** Reviewed `child_process` importers; the first is the row's owner. One-way ratchet: this list may shrink, additions require deliberate review. */
export const ALLOWED_IMPORTERS: readonly string[] = [
  "src/utils/HostCommandExecutor.ts",
  "src/utils/daemonProcessCommand.ts",
  "src/daemon/devicePool.ts",
  "src/daemon/processTable.ts",
  "src/utils/GitMetadataClient.ts",
  "src/ctrlProxy/IOSCtrlProxyManager.ts",
];

export interface ImportHit {
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export function findChildProcessImports(file: string, source: string): ImportHit[] {
  if (!source.includes("child_process")) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: ImportHit[] = [];
  const record = (node: ts.Node): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ line: line + 1, column: character + 1, text: "" });
  };
  const isChildProcessModule = (node: ts.Node | undefined): boolean =>
    !!node && ts.isStringLiteral(node) && CHILD_PROCESS_MODULES.has(node.text);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isChildProcessModule(node.moduleSpecifier)) {
      record(node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isChildProcessModule(node.moduleReference.expression)
    ) {
      record(node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      isChildProcessModule(node.arguments[0])
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}
