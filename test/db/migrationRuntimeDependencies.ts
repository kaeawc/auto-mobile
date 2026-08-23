/**
 * Guard for {@link MIGRATION_RUNTIME_DEPENDENCIES} drift (issue #2867,
 * follow-up to #2833 / PR #2851).
 *
 * The incomplete-extraction recovery in `migrationDependencyIntegrity.ts` only
 * reframes a `Cannot find package '<x>'` failure into the recoverable
 * `AUTOMOBILE_INCOMPLETE_EXTRACTION` error when `<x>` is in the hardcoded
 * `MIGRATION_RUNTIME_DEPENDENCIES` allowlist. That scoping is deliberate — it
 * keeps a genuine code-level bad import (a typo, an unpublished dep) from being
 * mislabeled "incomplete extraction, re-extract". But it means the allowlist
 * must stay in sync with the *runtime value imports* in `src/db/migrations/*.ts`:
 * a new runtime import from a package not in the list silently loses the
 * actionable recovery message for that dependency.
 *
 * This is a pure `(source) -> package names` extractor so it is unit-tested
 * with string fixtures (no filesystem) and then applied to the real migrations
 * directory by the meta-test — both stay well under 100ms.
 *
 * Scope: the migration files use only single-line named imports
 * (`import { ... } from "<spec>"`, optionally `import type` or with inline
 * `type` members). The extractor handles that surface deliberately — a future
 * migration using a default/namespace/side-effect import would need the parser
 * extended, and the accompanying test documents the covered forms.
 */

/**
 * Matches a single-line ES named import and captures the brace body (group 1)
 * and the module specifier (group 2). `import type { ... }` is captured too so
 * the type-only case can be distinguished from a value import by inspecting the
 * matched text (see {@link extractValueImportPackages}).
 */
const NAMED_IMPORT_PATTERN = /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/;

/** True for `import type { ... }` — a whole-clause type-only import. */
const TYPE_ONLY_IMPORT_PATTERN = /^\s*import\s+type\s+\{/;

/**
 * Reduce a module specifier to its bare package name:
 *   - `kysely`            -> `kysely`
 *   - `kysely/helpers`    -> `kysely`
 *   - `@scope/pkg`        -> `@scope/pkg`
 *   - `@scope/pkg/sub`    -> `@scope/pkg`
 * Relative specifiers (`./x`, `../x`) and absolute paths are NOT packages and
 * return null so they are excluded from the allowlist comparison.
 */
export function barePackageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    // Scoped: `@scope/name` — keep the first two segments.
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return parts[0];
}

/**
 * True when a named-import brace body contains at least one VALUE binding —
 * i.e. a member NOT prefixed with an inline `type`. `{ type Kysely, sql }`
 * yields true (`sql` is a value); `{ type Kysely }` / `{ type A, type B }`
 * yields false (all members are type-only).
 */
function hasValueMember(braceBody: string): boolean {
  return braceBody
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.length > 0)
    .some((member) => !/^type\s+/.test(member));
}

/**
 * Extract the distinct bare package names of the *runtime value* imports in a
 * migration source file. Excludes whole-clause `import type` imports, named
 * imports whose members are all inline-`type`, and relative-path imports.
 * Returns a sorted, de-duplicated list.
 */
export function extractValueImportPackages(source: string): string[] {
  const packages = new Set<string>();
  for (const line of source.split("\n")) {
    const match = NAMED_IMPORT_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    if (TYPE_ONLY_IMPORT_PATTERN.test(line)) {
      continue;
    }
    const [, braceBody, specifier] = match;
    if (!hasValueMember(braceBody)) {
      continue;
    }
    const name = barePackageName(specifier);
    if (name !== null) {
      packages.add(name);
    }
  }
  return [...packages].sort();
}

export interface MigrationDependencyDriftViolation {
  /** Package imported for its value at runtime but absent from the allowlist. */
  package: string;
  /** Migration filenames that import it, sorted. */
  files: string[];
  /** Human-readable, actionable description of the violation. */
  message: string;
}

/**
 * Compare the value-import packages found across a set of migration sources
 * against the declared allowlist. Returns a violation per package that a
 * migration imports at runtime but the allowlist omits. Clean -> empty array.
 *
 * `sources` maps a migration filename to its file contents; `allowlist` is the
 * declared {@link MIGRATION_RUNTIME_DEPENDENCIES}.
 */
export function findMigrationDependencyDrift(
  sources: ReadonlyMap<string, string>,
  allowlist: readonly string[],
): MigrationDependencyDriftViolation[] {
  const allowed = new Set(allowlist);
  const filesByPackage = new Map<string, string[]>();

  for (const [filename, source] of sources) {
    for (const pkg of extractValueImportPackages(source)) {
      if (allowed.has(pkg)) {
        continue;
      }
      const files = filesByPackage.get(pkg);
      if (files) {
        files.push(filename);
      } else {
        filesByPackage.set(pkg, [filename]);
      }
    }
  }

  return [...filesByPackage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, files]) => ({
      package: pkg,
      files: [...files].sort(),
      message:
        `Migration file(s) ${[...files].sort().join(", ")} do a runtime value import ` +
        `from "${pkg}", but "${pkg}" is not in MIGRATION_RUNTIME_DEPENDENCIES ` +
        "(src/db/migrationDependencyIntegrity.ts). A half-linked `bunx` extraction " +
        `missing "${pkg}" would fall through to the generic, non-actionable migration ` +
        "crash instead of the recoverable AUTOMOBILE_INCOMPLETE_EXTRACTION message " +
        "(issue #2833). Add it to the allowlist, OR — if this import is only used for " +
        "its types — change it to `import type { ... }` (or inline `type` members).",
    }));
}
