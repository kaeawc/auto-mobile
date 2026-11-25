import { BindingRegistrySchemaUnsupportedError } from "./sessionBroker/provisioning/BindingRegistrySchemaUnsupportedError";
import { BindingRegistryUpgradePendingError } from "./sessionBroker/registry/bindingRegistryMigrations";
import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";

export interface LocalClaimRegistryExpectationInputs {
  /** True once this daemon's control socket is bound; it then creates and migrates the registry. */
  socketBound: () => boolean;
  /** Whether the host registry file exists. */
  registryFileExists: () => boolean;
  /** The latest failed registry open's error, cleared when an open succeeds. */
  lastOpenFailure: () => unknown;
}

/**
 * Whether a registry must decide this local daemon's Android and iOS claims, given the failure
 * the claim saw (#11811, owner decision 2026-11-07, E1). When it must, a claim the table cannot
 * decide is refused retryably instead of falling back to the claim files.
 *
 * - After bind: always, since bound daemons create and migrate the registry.
 * - Before bind, with no registry file: the files decide, as they did before claims tables.
 * - Before bind, with a registry file: the registry must decide, unless the claim's failure (or
 *   the latest forgotten open's) says it still needs this release's migrations (no current
 *   daemon can have written a table-only claim yet, since every one migrates once bound) or has
 *   a schema this daemon does not know (files-only mode). A claim that finds no open registry
 *   starts one ({@link localPreBindRegistryOpen}), so a busy, failed or timed-out open or write,
 *   or no open at all, must not fall back.
 */
export function localClaimRegistryExpectation(
  inputs: LocalClaimRegistryExpectationInputs,
): (error?: unknown) => boolean {
  return (error) => {
    if (inputs.socketBound()) {
      return true;
    }
    if (!registryFilePresent(inputs.registryFileExists)) {
      // No registry exists: nothing could have decided.
      return false;
    }
    const failure = error ?? inputs.lastOpenFailure();
    return failure === undefined || !leavesClaimsToFiles(failure);
  };
}

/** Waits after a failed pre-bind claim open before a claim may start another: 1 s up to 30 s. */
export const PRE_BIND_REGISTRY_OPEN_BACKOFF: BackoffPolicy = exponentialBackoff({
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
});

export interface LocalPreBindRegistryOpenInputs {
  /** True while a claim may start the open: a local daemon whose socket is not bound yet. */
  preBind: () => boolean;
  /** True while a registry open is cached (in flight or open); a claim then joins it. */
  openCached: () => boolean;
  registryFileExists: () => boolean;
  /** The quiet, migrate-free open; it caches itself, so the claim's `whenOpen` joins it. */
  open: () => Promise<unknown>;
  timer: Pick<Timer, "now">;
  /** Waits after the nth consecutive failed open; defaults to {@link PRE_BIND_REGISTRY_OPEN_BACKOFF}. */
  backoff?: BackoffPolicy;
}

/**
 * Starts the registry open a pre-bind claim needs when the registry file appeared after this
 * daemon's startup check (#11811, E1), so the open's outcome decides the claim rather than the
 * claim files. A failed open is forgotten, so consecutive failures back off instead of
 * reopening on every claim; meanwhile the latest failure decides.
 */
export function localPreBindRegistryOpen(inputs: LocalPreBindRegistryOpenInputs): () => void {
  const backoff = inputs.backoff ?? PRE_BIND_REGISTRY_OPEN_BACKOFF;
  let opening = false;
  let failures = 0;
  let nextOpenAtMs = Number.NEGATIVE_INFINITY;
  return () => {
    if (
      opening ||
      !inputs.preBind() ||
      inputs.openCached() ||
      inputs.timer.now() < nextOpenAtMs ||
      !registryFileProbed(inputs.registryFileExists)
    ) {
      return;
    }
    const started = inputs.open();
    opening = true;
    void started.then(
      () => {
        opening = false;
        failures = 0;
        nextOpenAtMs = Number.NEGATIVE_INFINITY;
      },
      (error: unknown) => {
        opening = false;
        failures++;
        nextOpenAtMs = inputs.timer.now() + backoff.delayForAttempt(failures);
        // The claim that started this open joins it and is decided by this failure.
        logger.debug(`[DeviceClaims] Pre-bind registry open failed: ${errorMessage(error)}`);
      },
    );
  };
}

/** A probe that throws starts no open; the claim then fails closed (see {@link registryFilePresent}). */
function registryFileProbed(registryFileExists: () => boolean): boolean {
  try {
    return registryFileExists();
  } catch (error) {
    logger.warn(
      `[DeviceClaims] Cannot check for the host registry file; not opening it: ${errorMessage(error)}`,
      error,
    );
    return false;
  }
}

/** A schema this daemon may not use yet (pending) or at all (unsupported) leaves claims to files. */
function leavesClaimsToFiles(failure: unknown): boolean {
  return (
    failure instanceof BindingRegistryUpgradePendingError ||
    failure instanceof BindingRegistrySchemaUnsupportedError
  );
}

/** A probe that throws proves nothing about the file: assume it exists, so claims fail closed. */
function registryFilePresent(registryFileExists: () => boolean): boolean {
  try {
    return registryFileExists();
  } catch (error) {
    logger.warn(
      `[DeviceClaims] Cannot check for the host registry file; treating it as present: ${errorMessage(error)}`,
      error,
    );
    return true;
  }
}
