/**
 * Extraction-integrity checks for the startup database migrations (issue #2833).
 *
 * The migration modules ship as raw `.ts` files and are loaded from disk at
 * runtime by kysely's `FileMigrationProvider` via dynamic `import()`. Several of
 * them do a *runtime* value import (`import { sql } from "kysely"`), so the
 * runtime resolves `kysely` relative to the migrations folder on disk. When a
 * `bunx` extraction's `node_modules` is half-linked (the shared bun cache has the
 * package but it was never linked into this run's tree), that import throws
 * `Cannot find package 'kysely'` and the daemon's startup migration hard-fails
 * with a generic, non-actionable crash.
 *
 * This module turns that class of failure into a distinct, clearly *recoverable*
 * error: it names the missing package and the fix (remove the incomplete
 * extraction directory and re-run — a fresh extraction from the healthy shared
 * cache produces a complete tree). It also provides a cheap preflight so the
 * failure is caught before migrations run rather than deep inside the migrator.
 */

/** Distinct marker for a recoverable incomplete-extraction failure. */
export const INCOMPLETE_EXTRACTION_CODE = "AUTOMOBILE_INCOMPLETE_EXTRACTION";

/**
 * Packages the migration modules import at runtime (not just as types). These
 * must resolve from the migrations folder for `migrateToLatest()` to load the
 * migration files. Keep in sync with the value imports in `src/db/migrations/`.
 */
export const MIGRATION_RUNTIME_DEPENDENCIES: readonly string[] = ["kysely"];

/**
 * Resolves a module specifier the way the runtime would when loading a migration
 * file, throwing if it cannot be resolved. `fromDir` is the directory to resolve
 * from (the migrations folder) so the check mirrors the dynamic `import()` base.
 */
export type DependencyResolver = (specifier: string, fromDir: string) => string;

function getErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

const MISSING_PACKAGE_CODES = new Set(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"]);

// bun: "Cannot find package 'kysely' from '...'"; node: "Cannot find module 'kysely'".
const MISSING_PACKAGE_MESSAGE = /Cannot find (?:package|module) ['"]([^'"]+)['"]/i;

/**
 * True when `error` indicates a module/package could not be resolved — bun's
 * `ResolveMessage` ("Cannot find package '<x>' from '...'"), node's
 * `Cannot find module '<x>'`, or a `MODULE_NOT_FOUND`/`ERR_MODULE_NOT_FOUND`
 * code. This is the signature of a half-linked `bunx` extraction.
 */
export function isMissingPackageError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && MISSING_PACKAGE_CODES.has(code)) {
    return true;
  }
  return MISSING_PACKAGE_MESSAGE.test(getErrorMessage(error));
}

/**
 * Extract the unresolved package/module name from a missing-package error, or
 * null when the message does not name one.
 */
export function extractMissingPackageName(error: unknown): string | null {
  const match = MISSING_PACKAGE_MESSAGE.exec(getErrorMessage(error));
  return match ? match[1] : null;
}

/**
 * Build the recoverable incomplete-extraction error surfaced at startup. Carries
 * a distinct `code` so callers can branch, preserves the underlying `cause`, and
 * spells out the remediation.
 */
export function createIncompleteExtractionError(
  missingPackage: string | null,
  cause?: unknown
): Error {
  const subject = missingPackage
    ? `the package '${missingPackage}' could not be resolved`
    : "a required migration dependency could not be resolved";
  const message =
    `Database startup migrations cannot load their dependencies: ${subject}. ` +
    "This is an incomplete package extraction (e.g. a half-linked `bunx` " +
    "node_modules where the shared cache has the package but it was not linked " +
    "into this run's tree), not a missing or unpublished dependency. Remove the " +
    "incomplete extraction directory and re-run — a fresh extraction from the " +
    "healthy shared cache produces a complete tree and the daemon starts normally.";
  const error = new Error(message, cause === undefined ? undefined : { cause });
  (error as { code?: string }).code = INCOMPLETE_EXTRACTION_CODE;
  return error;
}

/** True when `error` is the recoverable incomplete-extraction error above. */
export function isIncompleteExtractionError(error: unknown): boolean {
  return getErrorCode(error) === INCOMPLETE_EXTRACTION_CODE;
}

/**
 * Return the first migration runtime dependency that does not resolve from
 * `migrationsFolder`, or null if every one resolves. A resolver that throws for
 * a non-resolution reason still counts the dependency as unresolvable — the
 * runtime import would fail the same way.
 */
export function findMissingMigrationDependency(
  migrationsFolder: string,
  resolve: DependencyResolver
): string | null {
  for (const dependency of MIGRATION_RUNTIME_DEPENDENCIES) {
    try {
      resolve(dependency, migrationsFolder);
    } catch {
      return dependency;
    }
  }
  return null;
}

/**
 * Preflight the extraction before running migrations: if a migration runtime
 * dependency cannot be resolved from `migrationsFolder`, throw the recoverable
 * incomplete-extraction error instead of letting the dynamic `import()` fail
 * deep inside the migrator with a generic message.
 */
export function assertMigrationDependenciesResolvable(
  migrationsFolder: string,
  resolve: DependencyResolver
): void {
  const missing = findMissingMigrationDependency(migrationsFolder, resolve);
  if (missing) {
    throw createIncompleteExtractionError(missing);
  }
}
