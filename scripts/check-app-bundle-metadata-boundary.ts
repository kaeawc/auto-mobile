import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/ios-cmdline-tools/AppBundleMetadataClient.ts";

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });

const directlyExecutesCodesign = (file: string): Array<{ line: number; column: number; text: string }> => {
  const source = readFileSync(file, "utf8");
  if (!/\bcodesign\b/i.test(source)) {
    return [];
  }
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const codesignAliases = new Set<string>();
  const violations: Array<{ line: number; column: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text === "codesign"
    ) {
      codesignAliases.add(node.name.text);
    }
    if (ts.isCallExpression(node) && node.arguments.some(argument =>
      (ts.isStringLiteral(argument) && argument.text === "codesign") ||
      (ts.isIdentifier(argument) && codesignAliases.has(argument.text))
    )) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        line: position.line + 1,
        column: position.character + 1,
        text: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

// Production diagnostics must use AppBundleMetadataClient as well. Tests are not
// scanned, and any future source exception needs a documented entry here.
const exceptions = new Map<string, string>([]);
const violations = sourceFiles(SOURCE_ROOT)
  .map(file => ({ file, repoPath: relative(".", file) }))
  .filter(({ repoPath }) => repoPath !== OWNER && !exceptions.has(repoPath))
  .flatMap(({ file, repoPath }) => directlyExecutesCodesign(file).map(violation => ({ repoPath, ...violation })));

if (violations.length > 0) {
  console.error("error: codesign execution must use AppBundleMetadataClient:");
  for (const violation of violations) {
    console.error(`${violation.repoPath}:${violation.line}:${violation.column}: ${violation.text}`);
  }
  process.exit(1);
}

console.log("app-bundle-metadata-boundary: no direct production codesign invocations.");
