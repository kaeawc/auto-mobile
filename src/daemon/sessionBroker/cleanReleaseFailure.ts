import { BootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import { classifySqliteError } from "../../db/databaseFailureClassification";
import { SimctlCommandTimeoutError } from "../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { SessionBrokerInvariantError } from "./SessionBrokerInvariantError";
import { SessionRequestOwnerMismatchError } from "./SessionRequestOwnerMismatchError";

type CleanReleaseFailureKind = "retryable" | "permanent" | "unknown";

function isRetryableNativeFailure(error: object): boolean {
  return (
    error instanceof SimctlCommandTimeoutError ||
    (error instanceof BootedDeviceDiscoveryIncompleteError &&
      error.platform === "ios" &&
      error.discoveryError?.retryable !== false) ||
    ("name" in error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

function classifyCause(error: unknown): CleanReleaseFailureKind {
  if (
    error instanceof SessionBrokerInvariantError ||
    error instanceof SessionRequestOwnerMismatchError
  ) {
    return "permanent";
  }
  if (typeof error !== "object" || error === null) {
    return "unknown";
  }
  if (isRetryableNativeFailure(error)) {
    return "retryable";
  }
  if ("code" in error && typeof error.code === "string" && error.code.startsWith("SQLITE_")) {
    // Supply only the code to the shared classifier: native busy/EAGAIN text is not SQLite.
    return classifySqliteError({ code: error.code }) === "retryable" ? "retryable" : "permanent";
  }
  return "unknown";
}

/** Inspect wrapped causes without message matching; known invariant failures take precedence. */
export function classifyCleanReleaseError(error: unknown): CleanReleaseFailureKind {
  const seen = new Set<unknown>();
  let result: CleanReleaseFailureKind = "unknown";
  while (!seen.has(error)) {
    seen.add(error);
    const kind = classifyCause(error);
    if (kind === "permanent") {
      return kind;
    }
    if (kind === "retryable") {
      result = kind;
    }
    error =
      typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  }
  return result;
}
