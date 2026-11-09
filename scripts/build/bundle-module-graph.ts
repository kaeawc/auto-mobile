import path from "node:path";
import ts from "typescript";

/** Reads one packed file's text by its POSIX package-relative path. */
export type PackedModuleReader = (packedPath: string) => string;

const BUNDLE_DIR = "dist/src/";

/** A built JavaScript module of the bundle: an entrypoint or a `splitting` chunk. */
export function isBundleModule(packedPath: string): boolean {
  return packedPath.startsWith(BUNDLE_DIR) && packedPath.endsWith(".js");
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** `import.meta.require("./chunk-…js")`, which Bun emits for a `require()` chunk boundary. */
function isImportMetaRequire(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "require" &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function isModuleCall(node: ts.CallExpression): boolean {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
    isImportMetaRequire(node)
  );
}

function specifierOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node) && node.arguments.length === 1 && isModuleCall(node)) {
    return node.arguments[0];
  }
  return undefined;
}

/**
 * Relative module specifiers one bundle module loads: static imports and re-exports,
 * dynamic `import()`, `require()` and `import.meta.require()`. Package and builtin
 * specifiers are not chunks and are left to the runtime dependency graph.
 */
export function relativeModuleSpecifiers(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    if (specifier && ts.isStringLiteralLike(specifier) && isRelative(specifier.text)) {
      specifiers.add(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers].sort();
}

/**
 * Walk the bundle's module graph from each packed entrypoint and report every
 * relative import whose target is not in the packed manifest, so a tarball that
 * drops a hashed `chunk-*.js` fails the gate instead of the first tool call.
 */
export function findMissingBundleModules(
  packedPaths: readonly string[],
  entrypoints: readonly string[],
  readModule: PackedModuleReader,
): string[] {
  const packed = new Set(packedPaths);
  const visited = new Set<string>();
  const missing: string[] = [];
  const queue = entrypoints.filter((entry) => packed.has(entry));
  // for-of re-reads the array length, so modules pushed during the walk are visited too.
  for (const current of queue) {
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const specifier of relativeModuleSpecifiers(current, readModule(current))) {
      const target = path.posix.join(path.posix.dirname(current), specifier);
      if (!packed.has(target)) {
        missing.push(`Missing bundle module: ${target} (imported by ${current})`);
      } else if (isBundleModule(target)) {
        queue.push(target);
      }
    }
  }
  return [...new Set(missing)].sort();
}
