import { SessionReleasedDuringCallError } from "../../sessionReleasedDuringCall";
import { ActionableError } from "../../../models/ActionableError";
import type { ManagedDeviceEntry, BindingPlatform } from "../registry/bindingRegistry";

/**
 * Typed refusal for a generic caller (no binding of its own) that tried to lend, adopt, start,
 * stop, delete or drive a device a binding holds (#11174, #11178). An idle assigned device is
 * not a free device, so this is not retryable: the device frees only when its scope is reset.
 */
export const DEVICE_ASSIGNED_TO_BINDING_CODE = "device_assigned_to_binding";

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

export class DeviceAssignedToBindingError extends ActionableError {
  readonly code = DEVICE_ASSIGNED_TO_BINDING_CODE;
  readonly retryable = false;
  readonly platform: BindingPlatform;
  readonly stableId: string;
  readonly scopeKey: string;
  /** The binding index holding the device, or null when it sits in the managed free pool. */
  readonly declaredBinding: number | null;

  constructor(
    action: string,
    readonly deviceId: string,
    entry: ManagedDeviceEntry,
  ) {
    super(
      `${action} refused: device '${deviceId}' (${entry.platform} ${entry.stableDeviceId}) is ` +
        (entry.holder === "binding"
          ? `assigned to binding ${entry.bindingIndex}`
          : "reserved for bindings") +
        ` (code ${DEVICE_ASSIGNED_TO_BINDING_CODE}). It stays reserved while idle; ` +
        "use another device, or reset the binding's scope to release it.",
    );
    this.name = "DeviceAssignedToBindingError";
    this.platform = entry.platform;
    this.stableId = entry.stableDeviceId;
    this.scopeKey = entry.scopeKey;
    this.declaredBinding = entry.bindingIndex;
  }

  /** The wire evidence: who holds the device, never a control credential. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      deviceId: this.deviceId,
      platform: this.platform,
      stableId: this.stableId,
      scopeKey: this.scopeKey,
      declaredBinding: this.declaredBinding,
      retryable: false,
    };
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
