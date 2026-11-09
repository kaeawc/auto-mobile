#!/usr/bin/env bun
/** Reversible CI pack-only trimming of the production bundled dependency closure. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { sortedReaddirEntriesSync } from "../../src/utils/io";

export interface PackageJson {
  version?: string;
  name: string;
  main?: string;
  module?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundledDependencies?: string[];
  browser?: string | Record<string, string | false>;
}
export interface BundledPackage {
  directory: string;
  metadata: PackageJson;
}
export interface Candidate {
  path: string;
  size: number;
  /** The PRUNE_CLASSES id that made this file removable. */
  class?: string;
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
  return sortedReaddirEntriesSync(directory).flatMap((entry) => {
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
      .filter(
        ([key]) =>
          // Bun and Node never resolve the browser condition; browser-builds owns those targets.
          key !== "types" && key !== "typings" && key !== "browser" && !key.startsWith("@"),
      )
      .flatMap(([, target]) => exportTargets(target));
  }
  return [];
}

function runtimeTargets(metadata: PackageJson): string[] {
  const bin = typeof metadata.bin === "string" ? [metadata.bin] : Object.values(metadata.bin ?? {});
  return [metadata.main, metadata.module, ...bin, ...exportTargets(metadata.exports)].filter(
    (target): target is string => typeof target === "string" && target.length > 0,
  );
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

function entryTargets(pkg: BundledPackage): string[] {
  const targets = runtimeTargets(pkg.metadata);
  if (!pkg.metadata.main && pkg.metadata.exports === undefined) {
    for (const extension of ["js", "mjs", "cjs", "ts", "mts", "cts", "json", "node"]) {
      const index = `index.${extension}`;
      if (existsSync(path.join(pkg.directory, index))) {
        targets.push(index);
      }
    }
  }
  return targets;
}

function protectedPaths(pkg: BundledPackage): string[] {
  const result: string[] = [];
  for (const target of entryTargets(pkg)) {
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

/** Legal notices are never removable, whatever class their name or directory matches. */
export function isLegalNotice(basename: string): boolean {
  return /^(LICENSE|LICENCE|NOTICE|COPYING|PATENTS|AUTHORS)/i.test(basename);
}

/** What a class matcher sees about one file inside one bundled package. */
export interface PruneFile {
  packageName: string;
  /** POSIX path relative to the package directory. */
  relative: string;
  /** Directory names leading to the file (excluding the basename). */
  directories: string[];
  basename: string;
  /** The package ships a built `dist/` directory beside its `src/`. */
  hasDist: boolean;
  /** POSIX paths named only by the package's `browser` field or `browser` export condition. */
  browserTargets: ReadonlySet<string>;
}

export interface PruneClass {
  id: string;
  description: string;
  /** Never loaded at runtime, so removable even inside a protected wildcard export prefix. */
  runtimeInert: boolean;
  matches: (file: PruneFile) => boolean;
}

const TEST_DIRECTORIES = ["test", "tests", "__tests__", "__snapshots__", "__image_snapshots__"];
const DOC_DIRECTORIES = ["docs", "example", "examples"];

/** Per-package browser-only builds that no field or condition names (audited by hand). */
const PACKAGE_BROWSER_BUILDS: Record<string, (relative: string) => boolean> = {
  // The root UMD build; main/exports name cjs/ and esm/ only.
  tinycolor2: (relative) => relative === "tinycolor.js" || relative === "dist/tinycolor-min.js",
};

/**
 * The allowlist of removable file classes. A file is removable only when one class
 * matches it, it is not a legal notice or package.json, no runtime entry protects it,
 * and no retained JS file names it literally.
 */
export const PRUNE_CLASSES: readonly PruneClass[] = [
  {
    id: "type-declarations",
    description: "TypeScript declaration files (.d.ts/.d.mts/.d.cts)",
    runtimeInert: true,
    matches: (file) => /\.d\.(ts|mts|cts)$/i.test(file.basename),
  },
  {
    id: "source-maps",
    description: "source maps",
    runtimeInert: true,
    matches: (file) => /\.map$/i.test(file.basename),
  },
  {
    id: "tests",
    description: "test directories, test files, snapshots and test-runner configs",
    runtimeInert: false,
    matches: (file) =>
      file.directories.some((part) => TEST_DIRECTORIES.includes(part)) ||
      /\.(test|spec)\.[cm]?[jt]s$/i.test(file.basename) ||
      /^test(_template)?\.[cm]?js$/i.test(file.basename) ||
      /^deno_asserts[^/]*\.mjs$/.test(file.basename) ||
      /^(vitest|jest)\.config[^/]*$/.test(file.basename) ||
      /\.snap$/i.test(file.basename),
  },
  {
    id: "docs",
    description: "markdown and documentation/example directories",
    runtimeInert: false,
    matches: (file) =>
      file.directories.some((part) => DOC_DIRECTORIES.includes(part)) ||
      /\.(md|markdown)$/i.test(file.basename) ||
      // exif-parser's cmd/ holds usage example scripts; it declares no bin.
      (file.packageName === "exif-parser" && file.directories[0] === "cmd"),
  },
  {
    id: "typescript-sources",
    description: "TypeScript sources (.ts/.mts/.cts)",
    runtimeInert: false,
    matches: (file) => /\.(ts|mts|cts)$/i.test(file.basename),
  },
  {
    id: "sources-with-dist",
    description: "src/ trees of packages that ship a built dist/",
    runtimeInert: false,
    matches: (file) => file.hasDist && file.directories[0] === "src",
  },
  {
    id: "browser-builds",
    description: "browser-only builds (browser field/condition targets, dist/browser, UMD)",
    runtimeInert: false,
    matches: (file) =>
      file.browserTargets.has(file.relative) ||
      (file.directories[0] === "dist" && file.directories[1] === "browser") ||
      /^browser(-global)?\.js$/.test(file.basename) ||
      /\.umd(\.min)?\.js$/.test(file.basename) ||
      (PACKAGE_BROWSER_BUILDS[file.packageName]?.(file.relative) ?? false),
  },
  {
    id: "tooling-config",
    description: "CI and build tooling config (.github/, YAML, Makefile)",
    runtimeInert: false,
    matches: (file) =>
      file.directories.includes(".github") ||
      /\.ya?ml$/i.test(file.basename) ||
      file.basename === "Makefile",
  },
];

/** The first allowlisted class a file belongs to, or undefined when it must stay. */
export function classifyRemovable(file: PruneFile): PruneClass | undefined {
  if (file.basename === "package.json" || isLegalNotice(file.basename)) {
    return undefined;
  }
  return PRUNE_CLASSES.find((pruneClass) => pruneClass.matches(file));
}

function conditionTargets(value: unknown, condition: string, inside = false): string[] {
  if (typeof value === "string") {
    return inside ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => conditionTargets(item, condition, inside));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, target]) =>
      conditionTargets(target, condition, inside || key === condition),
    );
  }
  return [];
}

function browserTargets(pkg: BundledPackage): Set<string> {
  const browser = pkg.metadata.browser;
  const declared = [
    ...(typeof browser === "string" ? [browser] : []),
    ...(browser && typeof browser === "object"
      ? Object.values(browser).filter((value): value is string => typeof value === "string")
      : []),
    ...conditionTargets(pkg.metadata.exports, "browser"),
  ];
  return new Set(
    declared.flatMap((target) => {
      const entry = target.includes("*") ? undefined : resolveEntry(pkg.directory, target);
      return entry ? [path.relative(pkg.directory, entry).split(path.sep).join("/")] : [];
    }),
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

function isProtected(
  filename: string,
  pruneClass: PruneClass,
  protectedEntries: readonly string[],
): boolean {
  return protectedEntries.some((entry) =>
    // An inert file (types, maps) is never an exact entry target, so only an exact
    // match protects it; wildcard prefixes and ambiguous whole-package keeps do not.
    pruneClass.runtimeInert ? entry === filename : inside(entry, filename),
  );
}

export function listCandidates(root: string, packages = collectBundledPackages(root)): Candidate[] {
  const candidates: Candidate[] = [];
  for (const pkg of packages) {
    const protectedEntries = protectedPaths(pkg);
    const allFiles = files(pkg.directory);
    const hasDist =
      existsSync(path.join(pkg.directory, "dist")) &&
      statSync(path.join(pkg.directory, "dist")).isDirectory();
    const browser = browserTargets(pkg);
    const classes = new Map<string, PruneClass>();
    for (const filename of allFiles) {
      const relative = path.relative(pkg.directory, filename).split(path.sep).join("/");
      const parts = relative.split("/");
      const pruneClass = classifyRemovable({
        packageName: pkg.metadata.name,
        relative,
        directories: parts.slice(0, -1),
        basename: parts.at(-1)!,
        hasDist,
        browserTargets: browser,
      });
      if (pruneClass && !isProtected(filename, pruneClass, protectedEntries)) {
        classes.set(filename, pruneClass);
      }
    }
    const removing = new Set(classes.keys());
    // Iterate to a fixed point: a retained file may itself refer to another candidate.
    let changed = true;
    while (changed) {
      changed = false;
      const js = allFiles.filter(
        (filename) => !removing.has(filename) && /\.(js|cjs|mjs)$/.test(filename),
      );
      for (const filename of removing) {
        if (!classes.get(filename)!.runtimeInert && referenced(filename, js)) {
          removing.delete(filename);
          changed = true;
        }
      }
    }
    for (const filename of removing) {
      candidates.push({
        path: path.relative(root, filename).split(path.sep).join("/"),
        size: statSync(filename).size,
        class: classes.get(filename)!.id,
      });
    }
  }
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

function assertEntries(packages: BundledPackage[]): void {
  for (const pkg of packages) {
    // Re-read metadata and resolve on the trimmed tree, independently of protection.
    for (const target of entryTargets({ ...pkg, metadata: readPackage(pkg.directory) })) {
      const literal = target.slice(0, target.indexOf("*"));
      const prefix = path.resolve(
        pkg.directory,
        literal.endsWith("/") ? literal : path.dirname(literal),
      );
      const entry = target.includes("*") ? prefix : resolveEntry(pkg.directory, target);
      if (
        !entry ||
        !inside(pkg.directory, entry) ||
        !existsSync(entry) ||
        (target.includes("*") && !statSync(entry).isDirectory())
      ) {
        throw new Error(`Trim removed runtime entry: ${pkg.directory}: ${target}`);
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
    throw new Error(
      `Unsafe trim manifest path: ${relative}. Move the backup aside and recover files manually before packing again.`,
    );
  }
  return filename;
}

export function restoreBackup(root: string): number {
  const backup = backupPath(root);
  if (!existsSync(backup)) {
    return 0;
  }
  let manifest: Candidate[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(backup, "manifest.json"), "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((item) => item && typeof item.path === "string")) {
      throw new Error("Invalid trim manifest");
    }
    manifest = parsed;
  } catch (error) {
    // An interrupted manifest write is recoverable from the mirrored backup paths.
    console.error(
      `Recovering trim backup by path: ${error instanceof Error ? error.message : String(error)}`,
    );
    const walk = (directory: string): Candidate[] =>
      sortedReaddirEntriesSync(directory).flatMap((entry) => {
        const filename = path.join(directory, entry.name);
        if (directory === backup && ["manifest.json", "manifest.json.tmp"].includes(entry.name)) {
          return [];
        }
        if (entry.isSymbolicLink()) {
          throw new Error(
            `Unsafe trim backup: ${filename}. Move the backup aside and recover files manually before packing again.`,
          );
        }
        return entry.isDirectory()
          ? walk(filename)
          : [{ path: path.relative(backup, filename), size: statSync(filename).size }];
      });
    manifest = walk(backup);
  }
  // Validate the entire plan before moving files so conflicts leave all backups intact.
  for (const item of manifest) {
    const original = checkedPath(root, item.path);
    const saved = checkedPath(backup, item.path);
    if (existsSync(original) && existsSync(saved)) {
      throw new Error(
        `Refusing to overwrite changed file: ${item.path}. Compare ${original} with ${saved}; move one copy aside, then rerun postpack.`,
      );
    }
    if (!existsSync(original) && !existsSync(saved)) {
      throw new Error(
        `Missing both backup and original: ${item.path}. Recover this file manually before rerunning postpack; keep ${backup}.`,
      );
    }
  }
  for (const item of manifest) {
    const original = checkedPath(root, item.path);
    const saved = checkedPath(backup, item.path);
    if (!existsSync(saved)) {
      continue; // Planned but not moved, or already restored after an interrupted postpack.
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
    if (existsSync(backupPath(root))) {
      options.stderr(`Bundled trim restored ${restoreBackup(root)} files.`);
    }
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
      options.stdout(`${item.path}\t${item.size}\t${item.class ?? ""}`);
    }
    options.stdout(`Total: ${candidates.length} files, ${total} bytes`);
    return;
  }
  const backup = backupPath(root);
  mkdirSync(backup, { recursive: true });
  // Write the complete plan BEFORE moving anything so a killed process is recoverable.
  writeFileSync(path.join(backup, "manifest.json.tmp"), `${JSON.stringify(candidates, null, 2)}\n`);
  renameSync(path.join(backup, "manifest.json.tmp"), path.join(backup, "manifest.json"));
  try {
    for (const item of candidates) {
      const original = checkedPath(root, item.path);
      const saved = checkedPath(backup, item.path);
      mkdirSync(path.dirname(saved), { recursive: true });
      renameSync(original, saved);
    }
    assertEntries(packages);
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
