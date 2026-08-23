/**
 * Recognises and reframes the startup-migration failure that occurs when a
 * package extraction is incomplete (issue #2833).
 *
 * The migration modules ship as raw `.ts` files and are loaded from disk at
 * runtime by kysely's `FileMigrationProvider` via dynamic `import()`. Several of
 * them do a *runtime* value import (`import { sql } from "kysely"`), so the
 * runtime resolves `kysely` relative to the migrations folder on disk. When a
 * `bunx` extraction's `node_modules` is half-linked (the shared bun cache has
 * the package but it was never linked into this run's tree), that import throws
 * `Cannot find package 'kysely'` and the daemon's startup migration hard-fails
 * with a generic, non-actionable crash.
 *
 * This module maps that specific failure — a *known* migration runtime
 * dependency failing to resolve — to a distinct, clearly *recoverable* error
 * that names the package and the fix (remove the incomplete extraction directory
 * and re-run; a fresh extraction from the healthy shared cache produces a
 * complete tree). Scoping to the known dependency list (rather than any missing
 * specifier) keeps a genuine code-level bad import — a typo'd or unpublished
 * package in a migration — from being mislabeled as an extraction problem.
 */

/** Distinct marker for a recoverable incomplete-extraction failure. */
export const INCOMPLETE_EXTRACTION_CODE = "AUTOMOBILE_INCOMPLETE_EXTRACTION";

/**
 * Process exit code the daemon uses when it dies from an incomplete extraction.
 * 75 is `EX_TEMPFAIL` from sysexits.h — "temporary failure; the user is invited
 * to retry" — which lets a wrapper distinguish this recoverable case from a
 * generic fatal (exit 1) and re-extract before retrying.
 */
export const INCOMPLETE_EXTRACTION_EXIT_CODE = 75;

/**
 * Packages the migration modules import at runtime (not just as types). These
 * must resolve from the migrations folder for `migrateToLatest()` to load the
 * migration files. Keep in sync with the value imports in `src/db/migrations/`;
 * a runtime import added there but omitted here degrades gracefully — its
 * missing-package failure falls through to the generic startup error rather than
 * this extraction-specific remediation.
 */
export const MIGRATION_RUNTIME_DEPENDENCIES: readonly string[] = ["kysely"];

function getErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  // bun throws a `ResolveMessage` for a failed dynamic import: it carries the
  // "Cannot find package '<x>' from '...'" text on `.message` but is NOT an
  // `instanceof Error`, so read `.message` off any object shape (issue #2833).
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : "";
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
 * True when `error` is a missing-package failure for a *known* migration runtime
 * dependency — i.e. the incomplete-extraction signature. A missing package that
 * is not a declared migration dependency (a typo, an unpublished dep) is
 * deliberately excluded so it is not mislabeled as an extraction problem.
 */
export function isMissingMigrationDependencyError(error: unknown): boolean {
  if (!isMissingPackageError(error)) {
    return false;
  }
  const name = extractMissingPackageName(error);
  return name !== null && MIGRATION_RUNTIME_DEPENDENCIES.includes(name);
}

/**
 * Build the recoverable incomplete-extraction error surfaced at startup. Carries
 * a distinct `code` so callers can branch (and the daemon can pick a distinct
 * exit code), preserves the underlying `cause`, and spells out the remediation.
 */
export function createIncompleteExtractionError(
  missingPackage: string | null,
  cause?: unknown,
): Error {
  const subject = missingPackage
    ? `the package '${missingPackage}' could not be resolved`
    : "a required migration dependency could not be resolved";
  const message =
    `Database startup migrations cannot load their dependencies: ${subject}. ` +
    "This is most commonly an incomplete package extraction — a half-linked " +
    "`bunx` node_modules where the shared cache has the package but it was not " +
    "linked into this run's tree. If you are running via `bunx`, remove the " +
    "incomplete extraction directory and re-run: a fresh extraction from the " +
    "healthy shared cache produces a complete tree and the daemon starts " +
    "normally. Otherwise, reinstall so the package is present in node_modules.";
  const error = new Error(message, cause === undefined ? undefined : { cause });
  (error as { code?: string }).code = INCOMPLETE_EXTRACTION_CODE;
  return error;
}

/** True when `error` is the recoverable incomplete-extraction error above. */
export function isIncompleteExtractionError(error: unknown): boolean {
  return getErrorCode(error) === INCOMPLETE_EXTRACTION_CODE;
}
