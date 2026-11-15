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
 *     packages it depends on;
 *   - a capitalized identifier in a target's code (comments and string text removed) that names
 *     a type defined elsewhere in the project, but not one the target can use, is a missing
 *     source, unless a lexical scope around it binds the name: a generic parameter of the
 *     enclosing declaration (`struct Use<T>`, `func echo<T>(_: T) -> T`), or a type declared
 *     directly in an enclosing body, in another body of the same type (`extension Own`), or in
 *     a type named in the enclosing type's header (`class Sub: Base`);
 *   - `Module.Type`, where `Module` is a local package and not a project type, is a missing
 *     source when the target does not depend on that package and the package declares `Type`.
 *
 * The check never reports a type defined only in Apple SDKs, and it never reports a name some
 * enclosing scope could bind. Nested types are matched by simple name across files, so a
 * same-named nested type in another type of the same name can hide a missing top-level type.
 * Other `.`-qualified names resolve through their qualifier, which is scanned itself. `import`
 * lines are skipped, and code inside `#if` branches is scanned like any other code.
 *
 *   bun scripts/ios/check-ctrl-proxy-target-types.ts [project-dir]
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
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
  /** The type as written: `Name`, or `Module.Name` for a module-qualified reference. */
  readonly type: string;
  /** Project files that define the type, none of which the target compiles. */
  readonly definedIn: readonly string[];
}

const TYPE_KEYWORDS = new Set(["struct", "class", "enum", "protocol", "actor", "extension"]);
const ALIAS_KEYWORDS = new Set(["typealias", "associatedtype"]);
const SCOPE_TOKEN =
  /[{}()]|(?<![A-Za-z0-9_$.])(struct|class|enum|protocol|actor|extension|typealias|associatedtype|func|init|subscript|let|var|case)(?![A-Za-z0-9_$])/g;
const TYPE_NAME = /\s+([A-Z][A-Za-z0-9_.]*)/y;
const FUNC_NAME = /\s+[A-Za-z_][A-Za-z0-9_]*|[?!]/y;
const GENERIC_PARAM = /^\s*(?:each\s+)?([A-Za-z_][A-Za-z0-9_]*)/;
// A `.`-qualified name (`Parent.Child`) resolves through its qualifier, which is scanned itself.
const CAPITALIZED = /(?<![A-Za-z0-9_$`.])[A-Z][A-Za-z0-9_]*/g;
const QUALIFIED_MEMBER = /\.([A-Z][A-Za-z0-9_]*)/y;
const IMPORT = /^[ \t]*(?:@[A-Za-z_]+(?:\([^)\n]*\))?[ \t]+)*import[ \t][^\n]*/gm;

/** A `{ ... }` region; `start` is the `{` index and `end` the matching `}` index. */
export interface Body {
  readonly start: number;
  end: number;
  /** The type a `struct`/`class`/`enum`/`protocol`/`actor`/`extension` body belongs to. */
  readonly owner?: string;
  /** Generic parameters of the declaration that owns the body. */
  readonly generics: readonly string[];
  /** Capitalized names in the owning type's header (`: Base, Proto where ...`). */
  readonly heritage: readonly string[];
  /** Type names declared directly in this body, which are visible unqualified inside it. */
  readonly members: Set<string>;
}

/** The span from a generic declaration's keyword to its body (or the end of its header). */
export interface GenericHeader {
  readonly start: number;
  end: number;
  readonly generics: readonly string[];
}

export interface SwiftScopes {
  /** Types declared outside any braces, which other files can name directly. */
  readonly topLevel: ReadonlySet<string>;
  readonly bodies: readonly Body[];
  readonly headers: readonly GenericHeader[];
}

interface Pending {
  readonly owner?: string;
  readonly nameEnd: number;
  readonly generics: readonly string[];
  readonly parenDepth: number;
  readonly braceDepth: number;
  readonly header: GenericHeader;
}

interface ScanState {
  readonly code: string;
  readonly topLevel: Set<string>;
  readonly bodies: Body[];
  readonly headers: GenericHeader[];
  readonly open: Body[];
  parenDepth: number;
  pending?: Pending;
}

/** Parameter names of the `<...>` clause at `from` (after whitespace), and where it ends. */
export function genericClause(
  code: string,
  from: number,
): { params: string[]; end: number } | undefined {
  const start = from + (/^\s*/.exec(code.slice(from))?.[0].length ?? 0);
  if (code[start] !== "<") {
    return undefined;
  }
  const items: string[] = [];
  let depth = 0;
  let itemStart = start + 1;
  for (let i = start; i < code.length; i += 1) {
    const c = code[i];
    if (c === "<" || c === "(" || c === "[") {
      depth += 1;
    } else if (c === ")" || c === "]" || (c === ">" && code[i - 1] !== "-")) {
      depth -= 1;
    }
    if ((c === "," && depth === 1) || depth === 0) {
      items.push(code.slice(itemStart, i));
      itemStart = i + 1;
    }
    if (depth === 0) {
      const params = items.flatMap((item) => GENERIC_PARAM.exec(item)?.[1] ?? []);
      return { params, end: i + 1 };
    }
  }
  return undefined;
}

function atPendingLevel(state: ScanState): boolean {
  const pending = state.pending;
  return (
    pending !== undefined &&
    pending.braceDepth === state.open.length &&
    pending.parenDepth === state.parenDepth
  );
}

function endPending(state: ScanState, at: number): Pending | undefined {
  const pending = state.pending;
  if (pending) {
    pending.header.end = at;
    state.pending = undefined;
  }
  return pending;
}

function capitalizedIn(text: string): string[] {
  return [...text.matchAll(CAPITALIZED)].map((match) => match[0]);
}

function openBody(state: ScanState, at: number): void {
  const owned = atPendingLevel(state) ? endPending(state, at) : undefined;
  const body: Body = {
    start: at,
    end: state.code.length,
    owner: owned?.owner,
    generics: owned?.generics ?? [],
    heritage: owned?.owner ? capitalizedIn(state.code.slice(owned.nameEnd, at)) : [],
    members: new Set(),
  };
  state.open.push(body);
  state.bodies.push(body);
}

function closeBody(state: ScanState, at: number): void {
  if (state.pending && state.pending.braceDepth === state.open.length) {
    endPending(state, at);
  }
  const body = state.open.pop();
  if (body) {
    body.end = at;
  }
}

/** Name and generic clause after a declaration keyword, or undefined for a modifier use. */
function readDeclaration(
  code: string,
  keyword: string,
  after: number,
): { name?: string; nameEnd: number; generics: string[] } | undefined {
  const pattern = TYPE_KEYWORDS.has(keyword) || ALIAS_KEYWORDS.has(keyword) ? TYPE_NAME : FUNC_NAME;
  pattern.lastIndex = after;
  const named = pattern.exec(code);
  if (!named && pattern === TYPE_NAME) {
    // `class func`, `class var`: a modifier, not a declaration.
    return undefined;
  }
  const nameEnd = named ? after + named[0].length : after;
  const name = pattern === TYPE_NAME ? named?.[1].split(".").pop() : undefined;
  return { name, nameEnd, generics: genericClause(code, nameEnd)?.params ?? [] };
}

function onKeyword(state: ScanState, keyword: string, at: number): void {
  if (keyword === "let" || keyword === "var" || keyword === "case") {
    if (atPendingLevel(state)) {
      endPending(state, at);
    }
    return;
  }
  const decl = readDeclaration(state.code, keyword, at + keyword.length);
  if (!decl) {
    return;
  }
  endPending(state, at);
  if (decl.name && keyword !== "extension") {
    (state.open.at(-1)?.members ?? state.topLevel).add(decl.name);
  }
  const header: GenericHeader = { start: at, end: state.code.length, generics: decl.generics };
  if (decl.generics.length > 0) {
    state.headers.push(header);
  }
  state.pending = {
    owner: TYPE_KEYWORDS.has(keyword) ? decl.name : undefined,
    nameEnd: decl.nameEnd,
    generics: decl.generics,
    parenDepth: state.parenDepth,
    braceDepth: state.open.length,
    header,
  };
}

/**
 * Lexical scopes of `code` (Swift with comments and string text already blanked): each brace
 * body with the types declared directly in it, and each generic declaration's parameters.
 */
export function swiftScopes(code: string): SwiftScopes {
  const state: ScanState = {
    code,
    topLevel: new Set(),
    bodies: [],
    headers: [],
    open: [],
    parenDepth: 0,
  };
  for (const match of code.matchAll(SCOPE_TOKEN)) {
    const token = match[0];
    if (token === "(") {
      state.parenDepth += 1;
    } else if (token === ")") {
      state.parenDepth = Math.max(0, state.parenDepth - 1);
    } else if (token === "{") {
      openBody(state, match.index);
    } else if (token === "}") {
      closeBody(state, match.index);
    } else {
      onKeyword(state, token, match.index);
    }
  }
  endPending(state, code.length);
  return { topLevel: state.topLevel, bodies: state.bodies, headers: state.headers };
}

export interface DeclaredTypes {
  /** Types declared outside any braces, which other files can name directly. */
  readonly topLevel: ReadonlySet<string>;
  /** Every declared type name, nested ones included. */
  readonly all: ReadonlySet<string>;
}

/** Type names declared in `source`, with comments and string text ignored. */
export function declaredTypes(source: string): DeclaredTypes {
  const scopes = swiftScopes(stripSwiftNonCode(source));
  const all = new Set([...scopes.topLevel, ...scopes.bodies.flatMap((body) => [...body.members])]);
  return { topLevel: scopes.topLevel, all };
}

/** Code of `source` with comments, string text and `import` lines blanked, newlines kept. */
function referencingCode(source: string): string {
  return stripSwiftNonCode(source).replace(IMPORT, (line) => " ".repeat(line.length));
}

/** Nested type names declared in any body of each type, across every file. */
function nestedTypesByOwner(scopes: Iterable<SwiftScopes>): Map<string, Set<string>> {
  const nested = new Map<string, Set<string>>();
  for (const body of [...scopes].flatMap((file) => file.bodies)) {
    if (body.owner) {
      nested.set(body.owner, new Set([...(nested.get(body.owner) ?? []), ...body.members]));
    }
  }
  return nested;
}

/** Whether a scope enclosing `index` binds `name` (generic parameter or visible nested type). */
export function isBoundAt(
  scopes: SwiftScopes,
  nested: ReadonlyMap<string, ReadonlySet<string>>,
  index: number,
  name: string,
): boolean {
  const inHeader = scopes.headers.some(
    (header) => header.start <= index && index < header.end && header.generics.includes(name),
  );
  return (
    inHeader ||
    scopes.bodies.some(
      (body) =>
        body.start < index &&
        index < body.end &&
        (body.members.has(name) ||
          body.generics.includes(name) ||
          [body.owner, ...body.heritage].some((type) => type && nested.get(type)?.has(name))),
    )
  );
}

interface ProjectIndex {
  readonly scopes: ReadonlyMap<string, SwiftScopes>;
  readonly definers: ReadonlyMap<string, readonly string[]>;
  readonly nested: ReadonlyMap<string, ReadonlySet<string>>;
  readonly packageFiles: ReadonlyMap<string, readonly string[]>;
}

/** `Module.Type` naming a type the target cannot reach because it lacks the package. */
function moduleQualifiedMiss(
  project: ProjectIndex,
  target: TargetSources,
  code: string,
  match: RegExpMatchArray,
): { type: string; definedIn: string[] } | undefined {
  const module = match[0];
  const files = project.packageFiles.get(module);
  if (!files || project.definers.has(module) || target.packages.includes(module)) {
    return undefined;
  }
  QUALIFIED_MEMBER.lastIndex = (match.index ?? 0) + module.length;
  const member = QUALIFIED_MEMBER.exec(code)?.[1];
  const definedIn = files.filter(
    (file) => member && project.scopes.get(file)?.topLevel.has(member),
  );
  return member && definedIn.length > 0 ? { type: `${module}.${member}`, definedIn } : undefined;
}

function missingInFile(
  project: ProjectIndex,
  target: TargetSources,
  available: ReadonlySet<string>,
  file: string,
  code: string,
): MissingType[] {
  const scopes = project.scopes.get(file) ?? swiftScopes(code);
  const reported = new Set<string>();
  const missing: MissingType[] = [];
  for (const match of code.matchAll(CAPITALIZED)) {
    const name = match[0];
    const definedIn = project.definers.get(name);
    const miss =
      definedIn && !available.has(name)
        ? { type: name, definedIn: [...definedIn] }
        : moduleQualifiedMiss(project, target, code, match);
    if (!miss || reported.has(miss.type) || isBoundAt(scopes, project.nested, match.index, name)) {
      continue;
    }
    reported.add(miss.type);
    const line = code.slice(0, match.index).split("\n").length;
    missing.push({ target: target.name, file, line, ...miss });
  }
  return missing;
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
  const code = new Map(Array.from(sources, ([file, text]) => [file, referencingCode(text)]));
  const scopes = new Map(Array.from(code, ([file, text]) => [file, swiftScopes(text)]));
  const definers = new Map<string, string[]>();
  for (const [file, fileScopes] of scopes) {
    for (const type of fileScopes.topLevel) {
      definers.set(type, [...(definers.get(type) ?? []), file]);
    }
  }
  const project: ProjectIndex = {
    scopes,
    definers,
    nested: nestedTypesByOwner(scopes.values()),
    packageFiles,
  };
  return targets.flatMap((target) => {
    const visible = [
      ...target.files,
      ...target.packages.flatMap((name) => packageFiles.get(name) ?? []),
    ];
    const available = new Set(visible.flatMap((file) => [...(scopes.get(file)?.topLevel ?? [])]));
    return target.files.flatMap((file) =>
      missingInFile(project, target, available, file, code.get(file) ?? ""),
    );
  });
}

type Source = string | { path?: unknown; excludes?: unknown };
type Dependency = { package?: unknown };
interface ProjectYml {
  packages?: Record<string, { path?: unknown }>;
  targets?: Record<string, { sources?: Source[]; dependencies?: Dependency[] }>;
}

/** `path` as a normalized project-relative POSIX path (`./A/b.swift` and `A//b.swift` → `A/b.swift`). */
export function projectRelativePath(projectDir: string, path: string): string {
  const relativePath = isAbsolute(path) ? relative(projectDir, path) : path;
  return posix.normalize(relativePath.replaceAll("\\", "/"));
}

function swiftFilesUnder(root: string, path: string, excludes: readonly string[]): string[] {
  const absolute = join(root, path);
  if (!statSync(absolute).isDirectory()) {
    return path.endsWith(".swift") ? [path] : [];
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of sortedReaddirEntriesSync(join(root, dir))) {
      // Keys are project-relative POSIX paths on every host, matching project.yml.
      const child = posix.join(dir, entry.name);
      const fromSource = posix.relative(path, child);
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

function sourceEntry(
  projectDir: string,
  target: string,
  source: Source,
): { path: string; excludes: string[] } {
  const path = typeof source === "string" ? source : source?.path;
  const excludes = typeof source === "string" ? [] : (source?.excludes ?? []);
  if (
    typeof path !== "string" ||
    !Array.isArray(excludes) ||
    !excludes.every((e) => typeof e === "string")
  ) {
    throw new Error(`Invalid source entry in target ${target}`);
  }
  return { path: projectRelativePath(projectDir, path), excludes };
}

/** Reads `project.yml`, every Swift file in the project, and the local packages it names. */
export function loadProject(projectDir: string): {
  targets: TargetSources[];
  sources: Map<string, string>;
  packageFiles: Map<string, string[]>;
} {
  const project = load(readFileSync(join(projectDir, "project.yml"), "utf8")) as ProjectYml;
  if (!project?.targets || typeof project.targets !== "object") {
    throw new Error("project.yml has no targets");
  }
  const packageFiles = new Map<string, string[]>();
  for (const [name, config] of Object.entries(project.packages ?? {})) {
    if (typeof config?.path === "string") {
      packageFiles.set(
        name,
        swiftFilesUnder(
          projectDir,
          projectRelativePath(projectDir, posix.join(config.path, "Sources")),
          [],
        ),
      );
    }
  }
  const targets = Object.entries(project.targets).map(([name, config]) => ({
    name,
    files: [
      ...new Set(
        (config.sources ?? []).flatMap((source) => {
          const { path, excludes } = sourceEntry(projectDir, name, source);
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
