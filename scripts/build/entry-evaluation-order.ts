import path from "node:path";
import ts from "typescript";
import type { PackedModuleReader } from "./bundle-module-graph";

/**
 * Source modules `src/index.ts` must evaluate before anything else, in this order:
 * the Bun runtime guard (a clear message under Node instead of a chunk's stack
 * trace) and the launcher-pid capture (#11041). With `splitting`, Bun inlines a
 * module only the entry imports into the entry's body, which ESM evaluates after
 * every chunk it statically imports. Listing these as their own entrypoints makes
 * each a shared, dependency-free chunk that the entry imports first.
 */
export const EARLY_EVALUATED_ENTRYPOINTS: readonly string[] = [
  "./src/runtime/bunRuntimeGuard.ts",
  "./src/daemon/processEntry.ts",
];

/** Built output path, relative to the bundle dir, of a `./src/...ts` entrypoint. */
export function builtEntryPath(sourceEntry: string): string {
  return sourceEntry.replace(/^\.\/src\//, "").replace(/\.ts$/, ".js");
}

/** Top-level static `import`/`export ... from` specifiers in source order. */
export function staticImportSpecifiers(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  return sourceFile.statements.flatMap((statement) => {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    return specifier && ts.isStringLiteralLike(specifier) ? [specifier.text] : [];
  });
}

/**
 * Check that the entry's first static imports are, in order, the chunks holding
 * each early entrypoint, and that each such chunk imports nothing, so no other
 * module's top-level code can run before them. Paths are POSIX, relative to the
 * bundle dir (e.g. `index.js`, `runtime/bunRuntimeGuard.js`).
 */
export function findEntryEvaluationOrderViolations(
  entry: string,
  earlyEntries: readonly string[],
  readModule: PackedModuleReader,
): string[] {
  const entryImports = staticImportSpecifiers(entry, readModule(entry)).map((specifier) =>
    path.posix.join(path.posix.dirname(entry), specifier),
  );
  return earlyEntries.flatMap((early, index) => {
    const targets = staticImportSpecifiers(early, readModule(early));
    if (targets.length !== 1) {
      return [`${early} was not split into one shared chunk (found ${targets.length} imports)`];
    }
    const chunk = path.posix.join(path.posix.dirname(early), targets[0]);
    const violations: string[] = [];
    if (entryImports[index] !== chunk) {
      violations.push(
        `${entry} import #${index + 1} is ${entryImports[index] ?? "missing"}, expected ${chunk} (${early})`,
      );
    }
    const chunkImports = staticImportSpecifiers(chunk, readModule(chunk));
    if (chunkImports.length > 0) {
      violations.push(
        `${chunk} (${early}) must import nothing; imports ${chunkImports.join(", ")}`,
      );
    }
    return violations;
  });
}
