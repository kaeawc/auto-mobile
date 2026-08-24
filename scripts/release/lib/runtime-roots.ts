import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

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
  for (const entry of readdirSync(dir)) {
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
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
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
 * Derive runtime roots from the built package. The bundle contributes only its
 * external dynamic imports, while copied runtime sources contribute all runtime
 * module forms.
 */
export function deriveRootsFromDist(distDir: string): string[] {
  const roots = new Set<string>();
  const entryPath = path.join(distDir, "src/index.js");

  if (existsSync(entryPath)) {
    const bundle = readFileSync(entryPath, "utf8");
    for (const root of runtimeRootsInSource(entryPath, bundle, true)) {
      roots.add(root);
    }
  }

  const sourceFiles: string[] = [];
  collectSourceFiles(distDir, sourceFiles);
  for (const file of sourceFiles) {
    if (file === entryPath) {
      continue;
    }
    for (const root of runtimeRootsInSource(file, readFileSync(file, "utf8"))) {
      roots.add(root);
    }
  }

  return [...roots].sort();
}
