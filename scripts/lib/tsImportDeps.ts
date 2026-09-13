#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

interface ResolveRelativeImportPathsOptions {
  maxDepth?: number;
  repoRoot?: string;
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
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function resolveRelativeSpecifier(importingFile: string, specifier: string): string | undefined {
  const literalPath = path.resolve(path.dirname(importingFile), specifier);
  const candidate = path.extname(literalPath) === "" ? `${literalPath}.ts` : literalPath;
  return existsSync(candidate) ? candidate : undefined;
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
  const visited = new Set<string>();
  const dependencies = new Set<string>();

  const visit = (filePath: string, depth: number): void => {
    const absolutePath = path.resolve(filePath);
    if (visited.has(absolutePath) || !existsSync(absolutePath)) {
      return;
    }
    visited.add(absolutePath);

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
      const dependency = resolveRelativeSpecifier(absolutePath, specifier);
      if (!dependency) {
        continue;
      }
      dependencies.add(path.relative(repoRoot, dependency).split(path.sep).join("/"));
      visit(dependency, depth + 1);
    }
  };

  visit(entryFilePath, 0);
  return [...dependencies].sort();
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const entryFilePath = process.argv[2];
  if (entryFilePath) {
    for (const dependency of resolveRelativeImportPaths(path.resolve(repoRoot, entryFilePath), {
      repoRoot,
    })) {
      console.log(dependency);
    }
  }
}
