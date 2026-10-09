import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { sortedReaddirEntriesSync } from "../src/utils/io";

const SOURCE_ROOT = "src";
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);

// One-way ratchet: this allowlist may shrink; additions require deliberate review.
const ALLOWED_IMPORTERS = new Set([
  "src/daemon/DaemonLauncher.ts",
  "src/daemon/devicePool.ts",
  "src/daemon/processTable.ts",
  "src/utils/GitMetadataClient.ts",
  "src/utils/HostCommandExecutor.ts",
  "src/ctrlProxy/IOSCtrlProxyManager.ts",
]);

interface Violation {
  file: string;
  line: number;
  column: number;
}

function sourceFiles(directory: string): string[] {
  return sortedReaddirEntriesSync(directory).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(file);
    }
    return entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [file] : [];
  });
}

function findViolations(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
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
  const violations: Violation[] = [];
  const record = (node: ts.Node): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file, line: line + 1, column: character + 1 });
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

const violations = sourceFiles(SOURCE_ROOT)
  .filter((file) => !ALLOWED_IMPORTERS.has(file.split(sep).join("/")))
  .flatMap(findViolations);

if (violations.length > 0) {
  console.error("error: child_process imports are restricted to the reviewed allowlist:");
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}:${violation.column}`);
  }
  process.exit(1);
}

console.log("child-process-import-boundary: no unlisted production imports.");
