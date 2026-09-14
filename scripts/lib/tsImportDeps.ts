#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Answers whether a repo-relative POSIX path is known to version control (index or merge-base tree). */
export interface KnownPathLookup {
  has(repoRelativePosixPath: string): boolean;
}

type CommandRunner = (file: string, args: string[]) => string;

const runCommand: CommandRunner = (file, args) => execFileSync(file, args, { encoding: "utf8" });

const noKnownPaths: KnownPathLookup = { has: () => false };

/**
 * Git-backed KnownPathLookup: the union of the index (`git ls-files`) and, when a base ref is
 * given, the tree at the merge-base with HEAD, so paths deleted on the branch are still known.
 * Loaded lazily on the first lookup; a git failure (e.g. a jj-only workspace) yields an empty set.
 */
export function gitKnownPathLookup(
  repoRoot: string,
  baseRef?: string,
  runner: CommandRunner = runCommand,
): KnownPathLookup {
  let known: Set<string> | undefined;
  const listedPaths = (args: string[]): string[] =>
    runner("git", ["-C", repoRoot, ...args])
      .split("\0")
      .filter((entry) => entry.length > 0);
  const load = (): Set<string> => {
    try {
      const paths = listedPaths(["ls-files", "-z"]);
      if (baseRef) {
        const mergeBase = runner("git", ["-C", repoRoot, "merge-base", baseRef, "HEAD"]).trim();
        paths.push(...listedPaths(["ls-tree", "-r", "-z", "--name-only", mergeBase]));
      }
      return new Set(paths);
    } catch (error) {
      // Without git metadata the resolver keeps its filesystem-only fallback, which is safe.
      console.error(`tsImportDeps: git path lookup unavailable: ${String(error)}`);
      return new Set();
    }
  };
  return {
    has: (candidate) => {
      known ??= load();
      return known.has(candidate);
    },
  };
}

interface ResolveRelativeImportPathsOptions {
  maxDepth?: number;
  repoRoot?: string;
  knownPaths?: KnownPathLookup;
}

function isRuntimeRequire(node: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

function relativeModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(".")
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      node.moduleReference.expression.text.startsWith(".")
    ) {
      specifiers.push(node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith(".")
    ) {
      specifiers.push(node.arguments[0].text);
    }
    if (
      ts.isCallExpression(node) &&
      isRuntimeRequire(node) &&
      node.arguments[0].text.startsWith(".")
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

const knownExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
]);

// Bun substitutes TypeScript sources for Node-style JavaScript specifiers when the .js file is absent.
const sourceSubstitutions: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

function toRepoRelativePosix(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

/**
 * Picks the first candidate that exists on disk; otherwise every candidate version control still
 * knows (so a deleted alternate target keeps its identity); otherwise the supplied fallback.
 */
function pickCandidates(
  candidates: string[],
  fallback: string,
  repoRoot: string,
  knownPaths: KnownPathLookup,
): string[] {
  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) {
    return [existing];
  }
  const known = candidates.filter((candidate) =>
    knownPaths.has(toRepoRelativePosix(repoRoot, candidate)),
  );
  return known.length > 0 ? known : [fallback];
}

function resolveRelativeSpecifier(
  importingFile: string,
  specifier: string,
  repoRoot: string,
  knownPaths: KnownPathLookup,
): string[] {
  const literalPath = path.resolve(path.dirname(importingFile), specifier);
  const extension = path.extname(specifier);
  const substitutions = sourceSubstitutions[extension];
  if (substitutions) {
    const stem = literalPath.slice(0, -extension.length);
    return pickCandidates(
      [literalPath, ...substitutions.map((sourceExtension) => `${stem}${sourceExtension}`)],
      literalPath,
      repoRoot,
      knownPaths,
    );
  }
  // A known explicit extension is trusted literally without a filesystem probe; anything else (no extension or an unrecognized dotted suffix) uses extensionless resolution.
  if (extension && knownExtensions.has(extension)) {
    return [literalPath];
  }
  return pickCandidates(
    [`${literalPath}.ts`, `${literalPath}.tsx`, path.join(literalPath, "index.ts")],
    `${literalPath}.ts`,
    repoRoot,
    knownPaths,
  );
}

/**
 * Resolves relative static import and export dependencies for a TypeScript entry point.
 * Returned paths are POSIX paths relative to repoRoot (or the current directory by default).
 */
export function resolveRelativeImportPaths(
  entryFilePath: string,
  options: ResolveRelativeImportPathsOptions = {},
): string[] {
  const maxDepth = options.maxDepth ?? 2;
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const knownPaths = options.knownPaths ?? noKnownPaths;
  const visited = new Map<string, number>();
  const dependencies = new Set<string>();

  const visit = (filePath: string, depth: number): void => {
    const absolutePath = path.resolve(filePath);
    const visitedDepth = visited.get(absolutePath);
    if ((visitedDepth !== undefined && visitedDepth <= depth) || !existsSync(absolutePath)) {
      return;
    }
    visited.set(absolutePath, depth);

    let source: string;
    try {
      source = readFileSync(absolutePath, "utf8");
    } catch {
      // A file can disappear between existsSync and readFileSync; skipping it is safe here.
      return;
    }
    const sourceFile = ts.createSourceFile(
      absolutePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    if (depth >= maxDepth) {
      return;
    }
    for (const specifier of relativeModuleSpecifiers(sourceFile)) {
      for (const dependency of resolveRelativeSpecifier(
        absolutePath,
        specifier,
        repoRoot,
        knownPaths,
      )) {
        dependencies.add(toRepoRelativePosix(repoRoot, dependency));
        visit(dependency, depth + 1);
      }
    }
  };

  visit(entryFilePath, 0);
  return [...dependencies].sort();
}

// Usage: bun scripts/lib/tsImportDeps.ts <entry.ts> [--base-ref <ref>]
// --base-ref lets deleted import targets keep their identity via the merge-base tree.
if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const args = process.argv.slice(2);
  const baseRefIndex = args.indexOf("--base-ref");
  const baseRef = baseRefIndex === -1 ? undefined : args[baseRefIndex + 1];
  if (baseRefIndex !== -1 && !baseRef) {
    console.error("Missing value for --base-ref");
    process.exit(1);
  }
  const entryFilePath = args.filter(
    (_, index) => index < baseRefIndex || index > baseRefIndex + 1 || baseRefIndex === -1,
  )[0];
  if (entryFilePath) {
    for (const dependency of resolveRelativeImportPaths(path.resolve(repoRoot, entryFilePath), {
      repoRoot,
      knownPaths: gitKnownPathLookup(repoRoot, baseRef),
    })) {
      console.log(dependency);
    }
  }
}
