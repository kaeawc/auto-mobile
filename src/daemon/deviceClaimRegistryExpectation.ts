import { BindingRegistrySchemaUnsupportedError } from "./sessionBroker/provisioning/BindingRegistrySchemaUnsupportedError";
import { BindingRegistryUpgradePendingError } from "./sessionBroker/registry/bindingRegistryMigrations";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

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
 * - Before bind, with no registry file, or with no open attempted (no failure seen): the files
 *   decide, as they did before claims tables.
 * - Before bind, with a registry file and a failed open or claim: the registry must decide,
 *   unless it still needs this release's migrations (no current daemon can have written a
 *   table-only claim yet, since every one migrates once bound) or has a schema this daemon does
 *   not know (files-only mode). A busy, failed or timed-out open or write must not fall back.
 */
export function localClaimRegistryExpectation(
  inputs: LocalClaimRegistryExpectationInputs,
): (error?: unknown) => boolean {
  return (error) => {
    if (inputs.socketBound()) {
      return true;
    }
    const failure = error ?? inputs.lastOpenFailure();
    if (failure === undefined || !registryFilePresent(inputs.registryFileExists)) {
      // No open was attempted before bind, or no registry exists: nothing could have decided.
      return false;
    }
    return !leavesClaimsToFiles(failure);
  };
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
