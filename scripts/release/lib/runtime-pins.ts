/**
 * Runtime dependency-graph pinning (issue #5421).
 *
 * `bun install -g @kaeawc/auto-mobile@<version>` re-resolves the transitive
 * `dependencies` graph from caret ranges at install time, so an unchanged
 * release can begin selecting dependency versions that did not exist when it was
 * published. On 2026-08-20 a staged `@peculiar/asn1-*@2.9.4` publish made clean
 * installs of `0.0.60` fail transiently. This module derives a *pinned* runtime
 * graph so a fixed release always resolves a fixed graph.
 *
 * The mechanism is exact top-level `dependencies`, which Bun honors on
 * `bun install -g` (verified empirically). A published `npm-shrinkwrap.json` is
 * ignored by Bun. The graph uses exact direct dependencies where possible and
 * selectively bundles the few conflicting Jimp transitives, avoiding native
 * `@img/sharp-*` binaries while preserving their resolved versions.
 *
 * This file is pure (no fs/network) so the unit tests stay fast and hermetic;
 * the CLI (`scripts/release/pin-runtime-deps.ts`) wires it to `bun.lock`,
 * `package.json`, and the built `dist/`.
 */

import ts from "typescript";

/** A single resolved node in a Bun lockfile. */
export interface LockNode {
  /** Package name, e.g. `@jimp/core`. */
  name: string;
  /** Exact resolved version, e.g. `1.6.1`. */
  version: string;
  /** name -> range for regular `dependencies`. */
  deps: Record<string, string>;
  /** name -> range for `optionalDependencies`. */
  optionalDeps: Record<string, string>;
}

/**
 * Parsed lockfile: every resolved node keyed by its lock key. A key is either a
 * bare `name` (hoisted) or a `parent/name` (or deeper) nesting path, matching
 * Bun's text lockfile layout.
 */
export type LockGraph = Map<string, LockNode>;

/** Split a lock id spec (`name@version` / `@scope/name@version`) into parts. */
export function splitIdSpec(idspec: string): { name: string; version: string } {
  const at = idspec.lastIndexOf("@");
  if (at <= 0) {
    return { name: idspec, version: "" };
  }
  return { name: idspec.slice(0, at), version: idspec.slice(at + 1) };
}

/**
 * Parse a Bun text lockfile (`bun.lock`). Bun's lockfile is JSONC (trailing
 * commas and comments), so TypeScript's structured JSONC parser handles its
 * syntax without rewriting string contents. Each `packages` entry is
 * `["name@version", registryHint?, { dependencies, optionalDependencies }?, hash?]`.
 */
export function parseBunLock(text: string): LockGraph {
  const result = ts.parseConfigFileTextToJson("bun.lock", text);
  if (result.error) {
    throw new Error(
      `Could not parse bun.lock: ${ts.flattenDiagnosticMessageText(result.error.messageText, "\n")}`,
    );
  }
  const parsed = result.config as {
    packages?: Record<string, unknown[]>;
  };
  const packages = parsed.packages ?? {};
  const graph: LockGraph = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    if (
      !Array.isArray(entry) ||
      entry.length === 0 ||
      typeof entry[0] !== "string"
    ) {
      continue;
    }
    const { name, version } = splitIdSpec(entry[0]);
    const meta = entry.find(
      (part): part is Record<string, unknown> =>
        Boolean(part) && typeof part === "object" && !Array.isArray(part),
    );
    const deps =
      (meta?.dependencies as Record<string, string> | undefined) ?? {};
    const optionalDeps =
      (meta?.optionalDependencies as Record<string, string> | undefined) ?? {};
    graph.set(key, { name, version, deps, optionalDeps });
  }
  return graph;
}

/**
 * The trailing package name of a lock key. Keys are `/`-joined package names, and
 * a scoped package (`@scope/name`) carries its own internal `/`, so the last
 * component is two segments when the penultimate segment is a scope. `@jimp/core`
 * → `@jimp/core`; `a/b/core` → `core`; `a/@scope/pkg` → `@scope/pkg`.
 */
export function lastKeyComponent(key: string): string {
  const segments = key.split("/");
  const penultimate = segments[segments.length - 2];
  if (penultimate?.startsWith("@")) {
    return `${penultimate}/${segments[segments.length - 1]}`;
  }
  return segments[segments.length - 1] ?? key;
}

/**
 * Resolve a dependency `name` referenced from `parentKey` to a lock key. Bun
 * records a nested `parent/name` entry when a package needs a version different
 * from the hoisted one; otherwise the bare hoisted `name` is used.
 */
export function resolveKey(
  graph: LockGraph,
  name: string,
  parentKey: string | null,
): string | null {
  if (parentKey) {
    const nested = `${parentKey}/${name}`;
    if (graph.has(nested)) {
      return nested;
    }
    // A nested package can resolve a sibling that its own parent has already
    // installed. Walk each ancestor before using a hoisted/global candidate.
    let ancestor = parentLockKey(parentKey);
    while (ancestor) {
      const candidate = `${ancestor}/${name}`;
      if (graph.has(candidate)) {
        return candidate;
      }
      ancestor = parentLockKey(ancestor);
    }
  }
  if (graph.has(name)) {
    return name;
  }
  // Fall back to any nested entry whose trailing package name is exactly `name`.
  // Compare on the full trailing component so an unscoped `core` never matches a
  // scoped `@jimp/core` (a plain `endsWith("/core")` would).
  for (const key of graph.keys()) {
    if (lastKeyComponent(key) === name) {
      return key;
    }
  }
  return null;
}

/** Return the containing package's lock key, accounting for scoped package names. */
function parentLockKey(key: string): string | null {
  const segments = key.split("/");
  const packageSegmentCount = segments[segments.length - 2]?.startsWith("@")
    ? 2
    : 1;
  const parent = segments.slice(0, -packageSegmentCount).join("/");
  return parent || null;
}

/**
 * Convert a Bun lock key to its path below a package's node_modules directory.
 * For example, `@jimp/diff/pixelmatch` becomes
 * `@jimp/diff/node_modules/pixelmatch`.
 */
export function lockKeyToNodeModulesPath(key: string): string {
  const packages: string[] = [];
  let current: string | null = key;
  while (current) {
    packages.unshift(lastKeyComponent(current));
    current = parentLockKey(current);
  }
  return packages.join("/node_modules/");
}

/**
 * Walk the runtime closure from `roots`, following regular `dependencies`
 * (transitively) and each node's `optionalDependencies` (which a consumer's
 * `bun install` will attempt to install when the platform matches). Returns a
 * map of package name -> the set of resolved versions reachable in the closure.
 */
export function resolveRuntimeClosure(
  graph: LockGraph,
  roots: string[],
): Map<string, Set<string>> {
  const versionsByName = new Map<string, Set<string>>();
  const visited = new Set<string>();

  const record = (name: string, version: string): void => {
    let set = versionsByName.get(name);
    if (!set) {
      set = new Set<string>();
      versionsByName.set(name, set);
    }
    if (version) {
      set.add(version);
    }
  };

  const walk = (key: string): void => {
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    const node = graph.get(key);
    if (!node) {
      return;
    }
    record(node.name, node.version);
    const edges = { ...node.deps, ...node.optionalDeps };
    for (const depName of Object.keys(edges)) {
      const depKey = resolveKey(graph, depName, key);
      if (!depKey) {
        throw new Error(
          `Runtime dependency ${depName} declared by ${node.name}@${node.version} has no matching bun.lock entry.`,
        );
      }
      walk(depKey);
    }
  };

  for (const root of roots) {
    const key = resolveKey(graph, root, null);
    if (!key) {
      throw new Error(`Runtime root ${root} has no matching bun.lock entry.`);
    }
    walk(key);
  }
  return versionsByName;
}

/**
 * Return the runtime lockfile paths that directly own one of `dependencyNames`,
 * along with the resolved versions each owner requires. These ownership paths
 * matter for bundled residuals: finding one matching version elsewhere in the
 * packed tree does not prove every package manager range is isolated from the
 * registry.
 */
export function findRuntimeDependencyOwners(
  graph: LockGraph,
  roots: string[],
  dependencyNames: string[],
): Record<string, Record<string, string[]>> {
  const watched = new Set(dependencyNames);
  const owners = new Map<string, Map<string, Set<string>>>();
  const visited = new Set<string>();

  const record = (
    ownerKey: string,
    dependency: string,
    version: string,
  ): void => {
    let dependencies = owners.get(ownerKey);
    if (!dependencies) {
      dependencies = new Map();
      owners.set(ownerKey, dependencies);
    }
    let versions = dependencies.get(dependency);
    if (!versions) {
      versions = new Set();
      dependencies.set(dependency, versions);
    }
    if (version) {
      versions.add(version);
    }
  };

  const walk = (key: string): void => {
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    const node = graph.get(key);
    if (!node) {
      return;
    }
    const edges = { ...node.deps, ...node.optionalDeps };
    for (const dependency of Object.keys(edges)) {
      const dependencyKey = resolveKey(graph, dependency, key);
      if (!dependencyKey) {
        throw new Error(
          `Runtime dependency ${dependency} declared by ${node.name}@${node.version} has no matching bun.lock entry.`,
        );
      }
      if (watched.has(dependency)) {
        record(key, dependency, graph.get(dependencyKey)?.version ?? "");
      }
      walk(dependencyKey);
    }
  };

  for (const root of roots) {
    const key = resolveKey(graph, root, null);
    if (!key) {
      throw new Error(`Runtime root ${root} has no matching bun.lock entry.`);
    }
    walk(key);
  }

  return Object.fromEntries(
    [...owners.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, dependencies]) => [
        owner,
        Object.fromEntries(
          [...dependencies.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([dependency, versions]) => [
              dependency,
              [...versions].sort(compareVersionDesc),
            ]),
        ),
      ]),
  );
}

/** A semver version string with no range operators (`^`, `~`, `x`, ranges, tags). */
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True when `spec` pins one exact version (what a pinned graph requires). */
export function isExactVersion(spec: string): boolean {
  return EXACT_VERSION.test(spec.trim());
}

export interface ComputePinsOptions {
  /**
   * Package-name prefixes excluded from the pinned `dependencies` even when they
   * are in the runtime closure. `@types/` is inert at runtime and pinning it
   * would collide with a dev `@types/node`; `@img/` binaries are platform-variant
   * and stay in `optionalDependencies` (already exact-pinned). Other `@img/`
   * packages, such as sharp's regular `@img/colour` dependency, stay pinned.
   */
  excludePrefixes?: string[];
}

export interface ComputedPins {
  /** Exact-pinned runtime dependencies (sorted). */
  dependencies: Record<string, string>;
  /** Every resolved version reachable in the runtime closure (sorted descending). */
  versions: Record<string, string[]>;
  /** Names that carry more than one version in the closure (only the hoisted one is pinnable via package.json). */
  multiVersion: Record<string, string[]>;
  /** Closure names skipped by an exclude prefix. */
  excluded: string[];
}

const DEFAULT_EXCLUDE_PREFIXES = ["@types/", "@img/sharp-"];

/**
 * Compute the exact-pinned runtime `dependencies` from a lock graph and the
 * runtime roots (the packages the built artifact actually imports from
 * node_modules). For a name resolved to multiple versions in the closure, the
 * highest version is pinned (Bun hoists it); the remaining versions are reported
 * in `multiVersion` because package.json can pin only the hoisted copy.
 */
export function computePins(
  graph: LockGraph,
  roots: string[],
  options: ComputePinsOptions = {},
): ComputedPins {
  const excludePrefixes = options.excludePrefixes ?? DEFAULT_EXCLUDE_PREFIXES;
  const closure = resolveRuntimeClosure(graph, roots);
  const dependencies: Record<string, string> = {};
  const versions: Record<string, string[]> = {};
  const multiVersion: Record<string, string[]> = {};
  const excluded: string[] = [];

  for (const [name, resolvedVersions] of closure) {
    if (excludePrefixes.some((prefix) => name.startsWith(prefix))) {
      excluded.push(name);
      continue;
    }
    const sorted = [...resolvedVersions].sort(compareVersionDesc);
    versions[name] = sorted;
    if (sorted.length > 1) {
      multiVersion[name] = sorted;
    }
    const pinned = sorted[0];
    if (pinned) {
      dependencies[name] = pinned;
    }
  }

  return {
    dependencies: sortRecord(dependencies),
    versions: sortRecord(versions),
    multiVersion: sortRecord(multiVersion),
    excluded: excluded.sort(),
  };
}

/**
 * Descending SemVer-precedence comparison for the package manager's hoist
 * choice. Bun's comparator correctly ranks stable releases above prereleases
 * and ignores build metadata for precedence.
 */
function compareVersionDesc(a: string, b: string): number {
  return Bun.semver.order(b, a);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key] as T;
  }
  return out;
}

export interface GraphMismatch {
  name: string;
  expected: string;
  resolved: string | undefined;
}

/**
 * Compare an intended pinned graph (`expected`) against the versions a real
 * install `resolved` (name -> version, `undefined` when absent). Used by the
 * clean-room CI gate to prove the packed artifact resolves the intended exact
 * versions. Returns the mismatches (empty when the graph reproduced exactly).
 */
export function findGraphMismatches(
  expected: Record<string, string>,
  resolved: Record<string, string | undefined>,
): GraphMismatch[] {
  const mismatches: GraphMismatch[] = [];
  for (const [name, want] of Object.entries(expected)) {
    const got = resolved[name];
    if (got !== want) {
      mismatches.push({ name, expected: want, resolved: got });
    }
  }
  return mismatches.sort((a, b) => a.name.localeCompare(b.name));
}

export interface RepartitionInput {
  /** Current `dependencies` from package.json. */
  currentDependencies: Record<string, string>;
  /** Current `devDependencies` from package.json. */
  currentDevDependencies: Record<string, string>;
  /** Runtime roots — the packages the built `dist/` imports from node_modules. */
  roots: string[];
  /** Exact runtime-closure pins (from `computePins`). */
  closurePins: Record<string, string>;
  /** Dependencies emitted by the prior runtime-graph manifest, if present. */
  previousRuntimeDependencies?: Record<string, string>;
}

export interface RepartitionResult {
  /** New `dependencies`: runtime roots + pure-transitive closure nodes, all exact. */
  dependencies: Record<string, string>;
  /** New `devDependencies`: everything else we build/test with, at our own versions. */
  devDependencies: Record<string, string>;
  /**
   * Runtime-closure names carried by a selected bundled parent because the repo
   * builds against another version. Their exact nested versions are recorded in
   * the manifest and asserted from the packed artifact by CI.
   */
  residualUnpinned: string[];
}

/**
 * Strategy A "right-size + pin": the published `dependencies` become the runtime
 * roots plus every *pure-transitive* runtime-closure node (exact-pinned). Any
 * current direct dependency (prod or dev) that is not a runtime root stays a
 * `devDependency` at our own version — it is inlined into `dist/` at build time
 * and only needed to build/test the repo. Crucially, a closure node whose name
 * we already use directly is NOT flattened into `dependencies`: that would pin
 * jimp's transitive `zod@3` over the `zod@4` our build inlines. The release
 * generator records those names so selected parent packages can bundle their
 * exact nested closure into the published artifact.
 */
export function repartitionDependencies(
  input: RepartitionInput,
): RepartitionResult {
  const {
    currentDependencies,
    currentDevDependencies,
    roots,
    closurePins,
    previousRuntimeDependencies = {},
  } = input;
  const rootSet = new Set(roots);
  const currentSpecOf = (name: string): string | undefined =>
    currentDependencies[name] ?? currentDevDependencies[name];

  const dependencies: Record<string, string> = {};
  const residualUnpinned: string[] = [];

  for (const [name, version] of Object.entries(closurePins)) {
    const current = currentSpecOf(name);
    const wasGeneratedPin =
      current !== undefined && previousRuntimeDependencies[name] === current;
    if (rootSet.has(name)) {
      dependencies[name] = version;
    } else if (
      current !== undefined &&
      current !== version &&
      !wasGeneratedPin
    ) {
      // We already use this name directly at a DIFFERENT version (our build
      // inlines that version). Pinning the transitive version here would collide
      // with the build dependency, so leave it to transitive resolution and let
      // the published artifact bundles it beneath its exact runtime parent. A
      // version recorded in the prior manifest is a generated pin rather than a
      // build dependency, so refresh it normally.
      residualUnpinned.push(name);
    } else {
      dependencies[name] = version;
    }
  }

  // Everything currently direct that is not now a runtime dependency moves to (or
  // stays in) devDependencies at its own version.
  const devDependencies: Record<string, string> = { ...currentDevDependencies };
  for (const [name, range] of Object.entries(currentDependencies)) {
    if (!(name in dependencies)) {
      if (previousRuntimeDependencies[name] === range) {
        continue;
      }
      devDependencies[name] = range;
    }
  }
  // A name promoted into the runtime `dependencies` must never remain a
  // devDependency (npm/bun forbid a package in both, and the build version would
  // shadow the pin). This also keeps the function idempotent when a former
  // devDependency becomes a runtime root.
  for (const name of Object.keys(dependencies)) {
    delete devDependencies[name];
  }

  return {
    dependencies: sortRecord(dependencies),
    devDependencies: sortRecord(devDependencies),
    residualUnpinned: residualUnpinned.sort(),
  };
}
