#!/usr/bin/env bun
/** Import the bundled closure from the installed tarball without starting AutoMobile. */
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectBundledPackages,
  type BundledPackage,
  type PackageJson,
} from "../release/trim-bundled-deps";

/** Packages with only declarations or commands have no module to smoke-import. */
export function importSkipReason(
  metadata: PackageJson,
  filenames: readonly string[],
): string | undefined {
  if (
    metadata.main ||
    metadata.module ||
    metadata.exports !== undefined ||
    filenames.some((name) => /^index\.(js|cjs|mjs|ts|mts|cts|json|node)$/.test(name))
  ) {
    return undefined;
  }
  return metadata.bin
    ? "bin-only package (no importable entry)"
    : "no runtime entry (types-only package)";
}

/**
 * True when `resolved` lives under `directory`. Bun.resolveSync returns a real
 * path while `directory` may sit under a symlink (macOS `/var` -> `/private/var`),
 * so compare real paths on both sides.
 */
export function isInsidePackage(
  resolved: string,
  directory: string,
  realpath: (p: string) => string = realpathSync,
): boolean {
  return realpath(resolved).startsWith(`${realpath(directory)}${path.sep}`);
}

export interface SmokeFailure {
  pkg: BundledPackage;
  error: string;
}
export interface SmokeResult {
  imported: BundledPackage[];
  skipped: { pkg: BundledPackage; reason: string }[];
  failures: SmokeFailure[];
}
export interface SmokeDependencies {
  collect: (root: string) => BundledPackage[];
  filenames: (directory: string) => string[];
  importer: (pkg: BundledPackage) => Promise<unknown>;
}
export function packageLabel(pkg: BundledPackage): string {
  return `${pkg.metadata.name}@${pkg.metadata.version ?? "unknown"} (${pkg.directory})`;
}
export function formatFailures(failures: readonly SmokeFailure[]): string {
  return failures.map(({ pkg, error }) => `- ${packageLabel(pkg)}: ${error}`).join("\n");
}

export async function smokeInstalledBundledDeps(
  root: string,
  deps: SmokeDependencies,
): Promise<SmokeResult> {
  const result: SmokeResult = { imported: [], skipped: [], failures: [] };
  for (const pkg of deps.collect(root)) {
    const reason = importSkipReason(pkg.metadata, deps.filenames(pkg.directory));
    if (reason) {
      result.skipped.push({ pkg, reason });
      continue;
    }
    try {
      await deps.importer(pkg);
      result.imported.push(pkg);
    } catch (error) {
      result.failures.push({ pkg, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

async function importInstalledPackage(pkg: BundledPackage): Promise<unknown> {
  // Resolve by name beside this exact package, preserving Bun's export conditions
  // and nested versions. Scoped packages need the enclosing node_modules directory.
  const owner = pkg.metadata.name.startsWith("@")
    ? path.dirname(path.dirname(pkg.directory))
    : path.dirname(pkg.directory);
  const resolved = Bun.resolveSync(pkg.metadata.name, owner);
  if (!isInsidePackage(resolved, pkg.directory)) {
    throw new Error(`Resolved outside installed package: ${resolved}`);
  }
  return import(pathToFileURL(resolved).href);
}

if (import.meta.main) {
  try {
    const root = process.argv[2];
    if (!root || process.argv.length !== 3) {
      throw new Error("Usage: smoke-installed-bundled-deps.ts <installed-package-root>");
    }
    const result = await smokeInstalledBundledDeps(path.resolve(root), {
      collect: collectBundledPackages,
      filenames: (directory) => readdirSync(directory),
      importer: importInstalledPackage,
    });
    console.log(
      `Bundled imports passed (${result.imported.length}):\n${result.imported.map(packageLabel).join("\n")}`,
    );
    console.log(
      `Skipped (${result.skipped.length}):\n${result.skipped.map(({ pkg, reason }) => `${packageLabel(pkg)}: ${reason}`).join("\n")}`,
    );
    if (result.failures.length) {
      throw new Error(
        `Bundled imports failed (${result.failures.length}):\n${formatFailures(result.failures)}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
