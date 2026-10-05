#!/usr/bin/env bun
/** Reversible CI pack-only trimming of the production bundled dependency closure. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

interface PackageJson {
  name: string;
  main?: string;
  module?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundledDependencies?: string[];
}
export interface BundledPackage {
  directory: string;
  metadata: PackageJson;
}
export interface Candidate {
  path: string;
  size: number;
}
export interface TrimOptions {
  root: string;
  env: Record<string, string | undefined>;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  /** Test seam for proving that the independent post-move assertion restores entries. */
  candidates?: (root: string, packages: BundledPackage[]) => Candidate[];
}

export function shouldTrimBundledDeps(env: Record<string, string | undefined>): boolean {
  if (env.AUTOMOBILE_TRIM_BUNDLED_DEPS === "true") {
    return true;
  }
  if (env.AUTOMOBILE_TRIM_BUNDLED_DEPS === "false") {
    return false;
  }
  return env.CI === "true" || env.CI === "1";
}

function readPackage(directory: string): PackageJson {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as PackageJson;
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function resolveDependency(root: string, owner: string, name: string): string | undefined {
  if (!/^(@[^/]+\/)?[^/.][^/]*$/.test(name)) {
    throw new Error(`Invalid dependency name: ${name}`);
  }
  let current = owner;
  while (inside(root, current)) {
    if (path.basename(current) !== "node_modules") {
      const directory = path.join(current, "node_modules", name);
      if (existsSync(path.join(directory, "package.json"))) {
        return directory;
      }
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return undefined;
}

export function collectBundledPackages(root: string): BundledPackage[] {
  root = path.resolve(root);
  const pending = (readPackage(root).bundledDependencies ?? []).map((name) => ({
    owner: root,
    name,
    optional: false,
  }));
  const found = new Map<string, BundledPackage>();
  while (pending.length > 0) {
    const dependency = pending.pop()!;
    const directory = resolveDependency(root, dependency.owner, dependency.name);
    if (!directory) {
      if (dependency.optional) {
        continue;
      }
      throw new Error(`Missing bundled dependency ${dependency.name} from ${dependency.owner}`);
    }
    if (found.has(directory)) {
      continue;
    }
    // Linked packages could point outside the pack root. Keep rather than traverse them.
    if (lstatSync(directory).isSymbolicLink()) {
      throw new Error(`Cannot safely trim linked bundled package: ${directory}`);
    }
    const metadata = readPackage(directory);
    found.set(directory, { directory, metadata });
    const optional = metadata.optionalDependencies ?? {};
    for (const name of Object.keys({ ...metadata.dependencies, ...optional })) {
      pending.push({ owner: directory, name, optional: name in optional });
    }
  }
  return [...found.values()].sort((a, b) => a.directory.localeCompare(b.directory));
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) {
      return [];
    }
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : entry.isFile() ? [filename] : [];
  });
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(exportTargets);
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => key !== "types" && key !== "typings" && !key.startsWith("@"))
      .flatMap(([, target]) => exportTargets(target));
  }
  return [];
}

function runtimeTargets(metadata: PackageJson): string[] {
  const bin = typeof metadata.bin === "string" ? [metadata.bin] : Object.values(metadata.bin ?? {});
  return [
    metadata.main ?? (metadata.exports ? undefined : "index.js"),
    metadata.module,
    ...bin,
    ...exportTargets(metadata.exports),
  ].filter((target): target is string => typeof target === "string");
}

/** Node's legacy main probing, also retaining direct ESM/module targets. */
function resolveEntry(
  directory: string,
  target: string,
  seen = new Set<string>(),
): string | undefined {
  const filename = path.resolve(directory, target);
  if (!inside(directory, filename) || seen.has(filename)) {
    return undefined;
  }
  seen.add(filename);
  for (const suffix of ["", ".js", ".json", ".node"]) {
    const probe = filename + suffix;
    if (existsSync(probe) && statSync(probe).isFile()) {
      return probe;
    }
  }
  if (existsSync(filename) && statSync(filename).isDirectory()) {
    if (existsSync(path.join(filename, "package.json"))) {
      const main = readPackage(filename).main;
      if (main) {
        const entry = resolveEntry(filename, main, seen);
        if (entry) {
          return entry;
        }
      }
    }
    for (const suffix of [".js", ".json", ".node"]) {
      const index = path.join(filename, `index${suffix}`);
      if (existsSync(index) && statSync(index).isFile()) {
        return index;
      }
    }
  }
  return undefined;
}

function protectedPaths(pkg: BundledPackage): string[] {
  const result: string[] = [];
  for (const target of runtimeTargets(pkg.metadata)) {
    if (target.includes("*")) {
      const literal = target.slice(0, target.indexOf("*"));
      const prefix = path.resolve(
        pkg.directory,
        literal.endsWith("/") ? literal : path.dirname(literal),
      );
      result.push(inside(pkg.directory, prefix) ? prefix : pkg.directory);
    } else {
      const entry = resolveEntry(pkg.directory, target);
      // An unresolved/invalid entry is ambiguous: retain the entire package.
      result.push(entry ?? pkg.directory);
    }
  }
  return result;
}

function removalPattern(name: string, relative: string): boolean {
  const parts = relative.split("/");
  const basename = parts.at(-1)!;
  if (
    basename === "package.json" ||
    /^(README|LICENSE|LICENCE|NOTICE|COPYING|PATENTS)/i.test(basename)
  ) {
    return false;
  }
  if (
    parts
      .slice(0, -1)
      .some((part) =>
        ["test", "tests", "__tests__", "docs", "example", "examples", ".github"].includes(part),
      )
  ) {
    return true;
  }
  if (/\.(ts|mts|cts|map|snap|md|ya?ml)$/i.test(basename) || basename === "Makefile") {
    return true;
  }
  if (name === "pngjs") {
    return relative === "browser.js";
  }
  if (name === "exif-parser") {
    return relative === "browser-global.js" || relative.startsWith("cmd/");
  }
  // Keep the root UMD and esm/cjs test builds: remaining test_template.js files
  // contain basename references to them (conservative reference-audit policy).
  return (
    name === "tinycolor2" &&
    (["dist/tinycolor-min.js"].includes(relative) || /^deno_asserts[^/]*\.mjs$/.test(basename))
  );
}

/** Conservative literal reference guard; no attempt to parse arbitrary dependency JS. */
function referenced(filename: string, remainingJs: string[]): boolean {
  return remainingJs.some((source) => {
    let relative = path.relative(path.dirname(source), filename).split(path.sep).join("/");
    if (!relative.startsWith(".")) {
      relative = `./${relative}`;
    }
    const variants = [relative];
    if (/\.(js|mjs|cjs)$/.test(relative)) {
      variants.push(relative.replace(/\.(js|mjs|cjs)$/, ""));
    }
    const content = readFileSync(source, "utf8");
    return variants.some((value) =>
      ["'", '"', "`"].some((quote) => content.includes(`${quote}${value}${quote}`)),
    );
  });
}

export function listCandidates(root: string, packages = collectBundledPackages(root)): Candidate[] {
  const candidates: Candidate[] = [];
  for (const pkg of packages) {
    const protectedEntries = protectedPaths(pkg);
    const allFiles = files(pkg.directory);
    const possible = allFiles.filter(
      (filename) =>
        removalPattern(
          pkg.metadata.name,
          path.relative(pkg.directory, filename).split(path.sep).join("/"),
        ) && !protectedEntries.some((entry) => inside(entry, filename)),
    );
    const removing = new Set(possible);
    // Iterate to a fixed point: a retained file may itself refer to another candidate.
    let changed = true;
    while (changed) {
      changed = false;
      const js = allFiles.filter(
        (filename) => !removing.has(filename) && /\.(js|cjs|mjs)$/.test(filename),
      );
      for (const filename of removing) {
        if (!/\.(d\.(ts|mts|cts)|map)$/.test(filename) && referenced(filename, js)) {
          removing.delete(filename);
          changed = true;
        }
      }
    }
    for (const filename of removing) {
      candidates.push({
        path: path.relative(root, filename).split(path.sep).join("/"),
        size: statSync(filename).size,
      });
    }
  }
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

function assertEntries(packages: BundledPackage[], entries: string[][]): void {
  for (let i = 0; i < packages.length; i++) {
    for (const entry of entries[i]!) {
      if (!existsSync(entry)) {
        throw new Error(`Trim removed runtime entry: ${entry}`);
      }
    }
  }
}

function backupPath(root: string): string {
  return path.join(root, ".pack-trim-backup");
}
function checkedPath(root: string, relative: string): string {
  const filename = path.resolve(root, relative);
  if (!inside(path.join(root, "node_modules"), filename)) {
    throw new Error(`Unsafe trim manifest path: ${relative}`);
  }
  return filename;
}

export function restoreBackup(root: string): number {
  const backup = backupPath(root);
  if (!existsSync(backup)) {
    return 0;
  }
  const manifest = JSON.parse(
    readFileSync(path.join(backup, "manifest.json"), "utf8"),
  ) as Candidate[];
  for (const item of manifest) {
    const original = checkedPath(root, item.path);
    const saved = checkedPath(backup, item.path);
    if (!existsSync(saved)) {
      if (!existsSync(original)) {
        throw new Error(`Missing both backup and original: ${item.path}`);
      }
      continue; // Planned but not moved, or already restored after an interrupted postpack.
    }
    if (existsSync(original)) {
      throw new Error(`Refusing to overwrite changed file: ${item.path}`);
    }
    mkdirSync(path.dirname(original), { recursive: true });
    renameSync(saved, original);
  }
  rmSync(backup, { recursive: true });
  return manifest.length;
}

export function runTrim(mode: string, options: TrimOptions): void {
  const root = path.resolve(options.root);
  if (mode === "postpack") {
    options.stderr(`Bundled trim restored ${restoreBackup(root)} files.`);
    return;
  }
  if (mode === "prepack" && !shouldTrimBundledDeps(options.env)) {
    options.stderr(
      "Bundled trim disabled (local pack; set AUTOMOBILE_TRIM_BUNDLED_DEPS=true to enable).",
    );
    return;
  }
  if (mode !== "prepack" && mode !== "list") {
    throw new Error("Usage: trim-bundled-deps.ts <prepack|postpack|list> [--root <dir>]");
  }
  if (mode === "prepack") {
    restoreBackup(root);
  }
  const packages = collectBundledPackages(root);
  const candidates = (options.candidates ?? listCandidates)(root, packages);
  const total = candidates.reduce((sum, item) => sum + item.size, 0);
  if (mode === "list") {
    for (const item of candidates) {
      options.stdout(`${item.path}\t${item.size}`);
    }
    options.stdout(`Total: ${candidates.length} files, ${total} bytes`);
    return;
  }
  // Snapshot independently of the candidate/protection rules, including wildcard files.
  const entries = packages.map((pkg) =>
    files(pkg.directory).filter((filename) =>
      protectedPaths(pkg).some((entry) => inside(entry, filename)),
    ),
  );
  const backup = backupPath(root);
  mkdirSync(backup, { recursive: true });
  // Write the complete plan BEFORE moving anything so a killed process is recoverable.
  writeFileSync(path.join(backup, "manifest.json"), `${JSON.stringify(candidates, null, 2)}\n`);
  try {
    for (const item of candidates) {
      const original = checkedPath(root, item.path);
      const saved = checkedPath(backup, item.path);
      mkdirSync(path.dirname(saved), { recursive: true });
      renameSync(original, saved);
    }
    assertEntries(packages, entries);
  } catch (error) {
    restoreBackup(root);
    throw error;
  }
  options.stderr(`Bundled trim removed ${candidates.length} files (${total} bytes).`);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 && !(args.length === 3 && args[1] === "--root")) {
      throw new Error("Usage: trim-bundled-deps.ts <prepack|postpack|list> [--root <dir>]");
    }
    runTrim(args[0]!, {
      root: args[2] ?? path.resolve(import.meta.dir, "../.."),
      env: process.env,
      stdout: (message) => console.log(message),
      stderr: (message) => console.error(message),
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
