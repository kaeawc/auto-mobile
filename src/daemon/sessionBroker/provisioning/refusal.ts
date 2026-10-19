import { SessionReleasedDuringCallError } from "../../sessionReleasedDuringCall";
import { ActionableError } from "../../../models/ActionableError";
import {
  DEVICE_ASSIGNED_TO_BINDING_CODE,
  DeviceAssignedToBindingError,
} from "../../../models/DeviceAssignedToBindingError";

export { DEVICE_ASSIGNED_TO_BINDING_CODE, DeviceAssignedToBindingError };

/**
 * The binding registry has never been readable in this daemon, so it cannot tell which
 * devices are assigned. Unknown is never "free" (#11174): allocation refuses, retryably.
 */
export const BINDING_DISCOVERY_INCOMPLETE_CODE = "discovery_incomplete";

/** This daemon does not understand the schema written by a newer registry owner. */
export const BINDING_REGISTRY_SCHEMA_UNSUPPORTED_CODE = "registry_schema_unsupported";

export class BindingRegistrySchemaUnsupportedError extends ActionableError {
  readonly code = BINDING_REGISTRY_SCHEMA_UNSUPPORTED_CODE;
  readonly retryable = false;

  constructor(
    readonly dbPath: string,
    readonly unknownMigrations: readonly string[],
  ) {
    super(
      `The binding registry at ${dbPath} contains migrations unknown to this daemon: ` +
        `${unknownMigrations.join(", ")}; nothing was changed.`,
    );
    this.name = "BindingRegistrySchemaUnsupportedError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      retryable: this.retryable,
      dbPath: this.dbPath,
      unknownMigrations: this.unknownMigrations,
    };
  }
}

/** Retry hint while the registry is unreadable. */
export const BINDING_DISCOVERY_RETRY_AFTER_MS = 2_000;

/** Retry hint matching the re-owner's steady-state 1 s cadence while ownership is unconfirmed. */
export const BINDING_OWNERSHIP_RETRY_AFTER_MS = 1_000;

export class BindingOwnershipUnconfirmedError extends ActionableError {
  readonly code = "binding_ownership_unconfirmed";
  readonly retryable = true;
  readonly retryAfterMs = BINDING_OWNERSHIP_RETRY_AFTER_MS;

  constructor(readonly sessionUuid: string) {
    super(
      `Session '${sessionUuid}' binding ownership is not recorded for this daemon yet ` +
        "(the binding registry is busy or the binding is not ready); retry shortly.",
    );
    this.name = "BindingOwnershipUnconfirmedError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      sessionUuid: this.sessionUuid,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

export class BindingOwnershipLostError extends SessionReleasedDuringCallError {
  constructor(sessionUuid: string) {
    super(sessionUuid, "binding-ownership-lost");
    this.message = `Session ${sessionUuid} is terminal after binding-ownership-lost and cannot be reused. Acquire a new device with getAndroid or getApple.`;
    this.name = "BindingOwnershipLostError";
  }
}

export class BindingDiscoveryIncompleteError extends ActionableError {
  readonly code = BINDING_DISCOVERY_INCOMPLETE_CODE;
  readonly retryable = true;
  readonly retryAfterMs = BINDING_DISCOVERY_RETRY_AFTER_MS;

  constructor(cause: string) {
    super(
      `The binding registry is unreadable (${cause}), so assigned devices cannot be told ` +
        `apart from free ones (code ${BINDING_DISCOVERY_INCOMPLETE_CODE}); retry shortly.`,
    );
    this.name = "BindingDiscoveryIncompleteError";
  }

  toPayload(): Record<string, unknown> {
    return { code: this.code, retryable: true, retryAfterMs: this.retryAfterMs };
  }
}
