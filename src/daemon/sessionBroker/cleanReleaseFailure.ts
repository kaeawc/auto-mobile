import { classifySqliteError } from "../../db/databaseFailureClassification";
import { SimctlCommandTimeoutError } from "../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";

/** Reuse the DB classifier and native error identities, including ActionableError causes. */
export function isRetryableCleanReleaseError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (!seen.has(error)) {
    seen.add(error);
    if (classifySqliteError(error) === "retryable" || error instanceof SimctlCommandTimeoutError) {
      return true;
    }
    if (!(error instanceof Error)) {
      return false;
    }
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return true;
    }
    error = error.cause;
  }
  return false;
}
