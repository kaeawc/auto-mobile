import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { sortedReaddirSync } from "../../../src/utils/io";

const BUILTINS = new Set<string>(builtinModules);

function addRootFromSpec(roots: Set<string>, spec: string): void {
  if (
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("node:") ||
    spec.startsWith("bun:")
  ) {
    return;
  }
  const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  const topLevel = pkgName.split("/")[0];
  if (BUILTINS.has(pkgName) || BUILTINS.has(topLevel) || pkgName.startsWith("@img/")) {
    return;
  }
  roots.add(pkgName);
}

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of sortedReaddirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".js")) && !entry.endsWith(".map")) {
      out.push(full);
    }
  }
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function isRuntimeRequire(node: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

/** `import.meta.resolve("pkg/file")`: a package read from disk at runtime, not imported. */
function isImportMetaResolve(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "resolve" &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

function addStringSpecifier(roots: Set<string>, expression: ts.Expression | undefined): void {
  if (expression && ts.isStringLiteralLike(expression)) {
    addRootFromSpec(roots, expression.text);
  }
}

/**
 * Return runtime packages imported by one artifact source. Type-only imports and
 * source comments are omitted by the TypeScript parser rather than regex rules.
 */
export function runtimeRootsInSource(
  file: string,
  source: string,
  dynamicImportsOnly = false,
): string[] {
  const roots = new Set<string>();
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isImportMetaResolve(node))
    ) {
      addStringSpecifier(roots, node.arguments[0]);
    }
    if (!dynamicImportsOnly) {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        addStringSpecifier(roots, node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        addStringSpecifier(roots, node.moduleSpecifier);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        addStringSpecifier(roots, node.moduleReference.expression);
      } else if (ts.isCallExpression(node) && isRuntimeRequire(node)) {
        addStringSpecifier(roots, node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...roots].sort();
}

/**
 * Derive runtime roots from the built package. The bundle (index.js and its split
 * chunks) contributes only its external dynamic imports and `import.meta.resolve` specifiers, while copied runtime sources contribute all runtime
 * module forms.
 */
export function deriveRootsFromDist(distDir: string): string[] {
  const roots = new Set<string>();
  const bundleDir = path.join(distDir, "src");
  const entryPath = path.join(bundleDir, "index.js");
  // Code splitting moves the entry bundle's code into sibling chunk-*.js files,
  // which are scanned the same way as the entry they were split from.
  const isEntryBundle = (file: string): boolean =>
    file === entryPath ||
    (path.dirname(file) === bundleDir &&
      path.basename(file).startsWith("chunk-") &&
      file.endsWith(".js"));

  const sourceFiles: string[] = [];
  collectSourceFiles(distDir, sourceFiles);
  for (const file of sourceFiles) {
    const fileRoots = runtimeRootsInSource(file, readFileSync(file, "utf8"), isEntryBundle(file));
    for (const root of fileRoots) {
      roots.add(root);
    }
  }

  return [...roots].sort();
}
