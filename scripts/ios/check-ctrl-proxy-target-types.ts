/**
 * Checks that each CtrlProxy Xcode target compiles the files that define the types it uses (#18342).
 *
 * The tvOS and visionOS runner targets in `ios/control-proxy/project.yml` compile an explicit
 * subset of `Sources/CtrlProxy`, one file at a time. A type added to a listed file that uses a
 * type from an unlisted file builds for iOS and SwiftPM but fails `build-for-testing` for tvOS
 * and visionOS, which no Linux check can run. This check finds that statically:
 *
 *   - every Swift file under the project directory and its local packages defines top-level
 *     types (`struct`, `class`, `enum`, `protocol`, `actor`, `typealias` outside any braces);
 *   - a target can use the top-level types declared by its own sources and by the local
 *     packages it depends on, and each file can also use the nested types it declares;
 *   - a capitalized identifier in a target's code (comments and string text removed) that names
 *     a type defined elsewhere in the project, but not one the target can use, is a missing
 *     source.
 *
 * Types from Apple SDKs are never defined in the project, so they are never reported. Nested
 * types are not tracked, since another file can only reach them through their top-level parent.
 * `import` lines are skipped, and code inside `#if` branches is scanned like any other code.
 *
 *   bun scripts/ios/check-ctrl-proxy-target-types.ts [project-dir]
 */
import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { sortedReaddirEntriesSync } from "../../src/utils/io";
import { stripSwiftNonCode } from "./check-privacy-manifests";

export interface TargetSources {
  readonly name: string;
  /** Swift files the target compiles, relative to the project directory. */
  readonly files: readonly string[];
  /** Local packages the target depends on, by name. */
  readonly packages: readonly string[];
}

export interface MissingType {
  readonly target: string;
  readonly file: string;
  readonly line: number;
  readonly type: string;
  /** Project files that define the type, none of which the target compiles. */
  readonly definedIn: readonly string[];
}

const DECLARATION_OR_BRACE =
  /[{}]|(?<![A-Za-z0-9_$])(?:struct|class|enum|protocol|actor|typealias)\s+([A-Z][A-Za-z0-9_]*)/g;
// A `.`-qualified name (`Parent.Child`) resolves through its qualifier, which is scanned itself.
const CAPITALIZED = /(?<![A-Za-z0-9_$`.])[A-Z][A-Za-z0-9_]*/g;
const IMPORT = /^[ \t]*(?:@[A-Za-z_]+(?:\([^)\n]*\))?[ \t]+)*import[ \t][^\n]*/gm;

export interface DeclaredTypes {
  /** Types declared outside any braces, which other files can name directly. */
  readonly topLevel: ReadonlySet<string>;
  /** Every declared type name, nested ones included. */
  readonly all: ReadonlySet<string>;
}

/** Type names declared in `source`, with comments and string text ignored. */
export function declaredTypes(source: string): DeclaredTypes {
  const topLevel = new Set<string>();
  const all = new Set<string>();
  let depth = 0;
  for (const match of stripSwiftNonCode(source).matchAll(DECLARATION_OR_BRACE)) {
    if (match[0] === "{") {
      depth += 1;
    } else if (match[0] === "}") {
      depth = Math.max(0, depth - 1);
    } else {
      all.add(match[1]);
      if (depth === 0) {
        topLevel.add(match[1]);
      }
    }
  }
  return { topLevel, all };
}

/** Code of `source` with comments, string text and `import` lines blanked, newlines kept. */
function referencingCode(source: string): string {
  return stripSwiftNonCode(source).replace(IMPORT, (line) => " ".repeat(line.length));
}

/**
 * Reports each type a target uses that is defined in the project but not in a file the target
 * compiles or a package it depends on. `sources` maps every project and package Swift file to
 * its text; `packageFiles` lists each local package's Swift files.
 */
export function findMissingTypes(
  targets: readonly TargetSources[],
  sources: ReadonlyMap<string, string>,
  packageFiles: ReadonlyMap<string, readonly string[]>,
): MissingType[] {
  const declared = new Map(Array.from(sources, ([file, text]) => [file, declaredTypes(text)]));
  const definers = new Map<string, string[]>();
  for (const [file, types] of declared) {
    for (const type of types.topLevel) {
      definers.set(type, [...(definers.get(type) ?? []), file]);
    }
  }
  const missing: MissingType[] = [];
  for (const target of targets) {
    const visible = [
      ...target.files,
      ...target.packages.flatMap((name) => packageFiles.get(name) ?? []),
    ];
    const available = new Set(visible.flatMap((file) => [...(declared.get(file)?.topLevel ?? [])]));
    for (const file of target.files) {
      const code = referencingCode(sources.get(file) ?? "");
      const nested = declared.get(file)?.all ?? new Set<string>();
      const reported = new Set<string>();
      for (const match of code.matchAll(CAPITALIZED)) {
        const type = match[0];
        const definedIn = definers.get(type);
        if (!definedIn || available.has(type) || nested.has(type) || reported.has(type)) {
          continue;
        }
        reported.add(type);
        const line = code.slice(0, match.index).split("\n").length;
        missing.push({ target: target.name, file, line, type, definedIn });
      }
    }
  }
  return missing;
}

type Source = string | { path?: unknown; excludes?: unknown };
type Dependency = { package?: unknown };
interface Project {
  packages?: Record<string, { path?: unknown }>;
  targets?: Record<string, { sources?: Source[]; dependencies?: Dependency[] }>;
}

function swiftFilesUnder(root: string, path: string, excludes: readonly string[]): string[] {
  const absolute = join(root, path);
  if (!statSync(absolute).isDirectory()) {
    return path.endsWith(".swift") ? [path] : [];
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of sortedReaddirEntriesSync(join(root, dir))) {
      const child = join(dir, entry.name);
      const fromSource = relative(path, child);
      const excluded = excludes.some(
        (pattern) =>
          new Bun.Glob(pattern).match(fromSource) || new Bun.Glob(pattern).match(entry.name),
      );
      if (excluded || entry.name === ".build") {
        continue;
      }
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".swift")) {
        files.push(child);
      }
    }
  };
  walk(path);
  return files;
}

function sourceEntry(target: string, source: Source): { path: string; excludes: string[] } {
  const path = typeof source === "string" ? source : source?.path;
  const excludes = typeof source === "string" ? [] : (source?.excludes ?? []);
  if (
    typeof path !== "string" ||
    !Array.isArray(excludes) ||
    !excludes.every((e) => typeof e === "string")
  ) {
    throw new Error(`Invalid source entry in target ${target}`);
  }
  return { path, excludes };
}

/** Reads `project.yml`, every Swift file in the project, and the local packages it names. */
export function loadProject(projectDir: string): {
  targets: TargetSources[];
  sources: Map<string, string>;
  packageFiles: Map<string, string[]>;
} {
  const project = load(readFileSync(join(projectDir, "project.yml"), "utf8")) as Project;
  if (!project?.targets || typeof project.targets !== "object") {
    throw new Error("project.yml has no targets");
  }
  const packageFiles = new Map<string, string[]>();
  for (const [name, config] of Object.entries(project.packages ?? {})) {
    if (typeof config?.path === "string") {
      packageFiles.set(name, swiftFilesUnder(projectDir, join(config.path, "Sources"), []));
    }
  }
  const targets = Object.entries(project.targets).map(([name, config]) => ({
    name,
    files: [
      ...new Set(
        (config.sources ?? []).flatMap((source) => {
          const { path, excludes } = sourceEntry(name, source);
          return swiftFilesUnder(projectDir, path, excludes);
        }),
      ),
    ],
    packages: (config.dependencies ?? []).flatMap((dependency) =>
      typeof dependency?.package === "string" ? [dependency.package] : [],
    ),
  }));
  const all = new Set([
    ...swiftFilesUnder(projectDir, ".", []).filter((file) => file !== "Package.swift"),
    ...[...packageFiles.values()].flat(),
  ]);
  const sources = new Map(
    [...all].map((file) => [file, readFileSync(join(projectDir, file), "utf8")]),
  );
  return { targets, sources, packageFiles };
}

export function main(projectDir: string): number {
  try {
    const { targets, sources, packageFiles } = loadProject(projectDir);
    const missing = findMissingTypes(targets, sources, packageFiles);
    if (missing.length > 0) {
      for (const item of missing) {
        console.error(
          `${item.target}: ${item.file}:${item.line} uses ${item.type}, defined in ` +
            `${item.definedIn.join(", ")}, which ${item.target} does not compile`,
        );
      }
      console.error(
        "Fix: add the defining file to the target's sources in ios/control-proxy/project.yml " +
          "(then regenerate CtrlProxy.xcodeproj), or move the type that needs it out of the shared file.",
      );
      return 1;
    }
    console.log(
      `CtrlProxy targets compile the files that define every project type they use (${targets.length} targets)`,
    );
    return 0;
  } catch (error) {
    console.error(`CtrlProxy target type check could not run: ${String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  process.exitCode = main(resolve(process.argv[2] ?? join(root, "ios/control-proxy")));
}
