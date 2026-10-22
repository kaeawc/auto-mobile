import { BROKER_DEVICE_NAME_PREFIX } from "../persistedIdentity";
import { ProvisionDeviceError } from "../../../devices/exactDeviceProvisioning";
import { BootCapacityExhaustedError } from "../../../models/BootCapacityExhaustedError";
import { errorMessage } from "../../../utils/describeUnknownError";
import type {
  BindingAssignmentRecord,
  BindingBindingExpectation,
  BindingCasFailure,
  BindingExecOwner,
  BindingKey,
} from "../registry/bindingRegistry";
import type { BindingSpecFingerprint } from "./DefaultManagedSpecResolver";
import type { BindingReconcileFailure, BindingReconcileFailureCode } from "./ReconcileAbort";
import type {
  BindingReconcileRequest,
  BindingReconcileResult,
  BindingReconcileEvidence,
  BindingResolvedSpec,
} from "./reconciler";

const FAILURE_RETRYABILITY: Readonly<Record<BindingReconcileFailureCode, boolean>> = {
  spec_unsupported: false,
  runtime_incompatible: false,
  scope_not_valid: false,
  discovery_incomplete: true,
  binding_in_use: true,
  binding_settling: true,
  device_busy: true,
  reconcile_in_progress: true,
  cleanup_pending: true,
  capacity_exhausted: true,
  binding_budget_exhausted: true,
  concurrent_modification: true,
  readiness_incomplete: true,
  stale_session: true,
  provision_failed: false,
  timeout: true,
  cancelled: true,
};

const FAILURE_NEXT_ACTION: Readonly<Record<BindingReconcileFailureCode, string>> = {
  spec_unsupported: "Fix the requested spec; nothing was changed.",
  runtime_incompatible: "Request a model/runtime pair the host supports; nothing was changed.",
  scope_not_valid: "Use the current runner incarnation; this scope no longer accepts work.",
  discovery_incomplete: "Retry once device discovery completes; nothing destructive was done.",
  binding_in_use: "Wait for the binding's live execution to end, then retry.",
  binding_settling: "Wait for the previous execution's released work to settle, then retry.",
  device_busy: "Wait for the device's live session or foreign claim to end, then retry.",
  reconcile_in_progress: "Another reconciliation of this binding is in progress; retry later.",
  cleanup_pending: "The previous device could not be removed; retry after cleanup succeeds.",
  binding_budget_exhausted:
    "Free unused broker resources or raise limits.totalDeviceCap in the broker host configuration, then retry.",
  capacity_exhausted: "Shut down a device or raise the boot limit, then retry.",
  concurrent_modification: "The binding changed concurrently; retry to converge on its new state.",
  readiness_incomplete: "Retry; the device did not reach automation readiness.",
  stale_session:
    "Retry; an earlier execution's session on the binding device could not be released.",
  provision_failed: "Inspect the provision failure code; retry if it is retryable.",
  timeout: "Retry with a longer preparation timeout.",
  cancelled: "The preparation was cancelled; retry when needed.",
};

/**
 * `ambroker-<8 hex of scope key>-<binding>-g<generation>-<attempt nonce>`, valid as an AVD and
 * simulator name. The per-attempt nonce keeps two concurrent attempts on the same binding (another
 * daemon, or a retry while the first attempt still runs) from creating the same AVD name, whose
 * name is its stable id, so one attempt's cleanup can never delete the other's device.
 */
export function bindingDeviceName(key: BindingKey, generation: number, nonce: string): string {
  const safeNonce = nonce
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  if (safeNonce.length === 0) {
    throw new Error(`Binding device name nonce '${nonce}' has no usable characters`);
  }
  return `${BROKER_DEVICE_NAME_PREFIX}${bindingDeviceNameSuffix(key)}${generation}-${safeNonce}`;
}

export function bindingDeviceNameSuffix(key: BindingKey): string {
  return `${key.scopeKey.slice(0, 8)}-${key.bindingIndex}-g`;
}

/** The registry column form of a fingerprint: `v<version>:<hash>`. */
export function encodeManagedSpecFingerprint(fingerprint: BindingSpecFingerprint): string {
  return `v${fingerprint.version}:${fingerprint.hash}`;
}

export function failure(
  code: BindingReconcileFailureCode,
  message: string,
  extra: Partial<
    Pick<BindingReconcileFailure, "provision" | "capacity" | "budget" | "retryable">
  > = {},
): BindingReconcileFailure {
  return {
    code,
    retryable: extra.retryable ?? FAILURE_RETRYABILITY[code],
    message,
    nextAction: FAILURE_NEXT_ACTION[code],
    ...(extra.provision ? { provision: extra.provision } : {}),
    ...(extra.capacity ? { capacity: extra.capacity } : {}),
    ...(extra.budget ? { budget: extra.budget } : {}),
  };
}

export function casFailure(result: BindingCasFailure, step: string): BindingReconcileFailure {
  switch (result.kind) {
    case "scope_not_valid":
      return failure("scope_not_valid", `Binding scope is no longer valid (${step}).`);
    case "binding_missing":
      return failure("concurrent_modification", `Binding disappeared during ${step}.`);
    case "stale_binding":
      return failure(
        "concurrent_modification",
        `Binding binding changed during ${step} (now generation ${result.current.generation}).`,
      );
    case "device_assigned_elsewhere":
      return failure(
        "concurrent_modification",
        `Device is already assigned to binding ${result.holder.bindingIndex} of another scope (${step}).`,
      );
  }
}

/** A refused execution claim or fence, as a reconcile failure. */
export function claimFailure(
  result:
    | BindingCasFailure
    | { kind: "binding_in_use"; owner: BindingExecOwner }
    | { kind: "binding_not_ready" },
  step: string,
): BindingReconcileFailure {
  switch (result.kind) {
    case "binding_in_use":
      return failure(
        "binding_in_use",
        `Binding is held by live session ${result.owner.sessionUuid} (${step}).`,
      );
    case "binding_not_ready":
      return failure("concurrent_modification", `Binding stopped being ready during ${step}.`);
    default:
      return casFailure(result, step);
  }
}

export function externalDevicesField(devices: readonly string[] | undefined): {
  externalDevices?: string[];
} {
  return devices && devices.length > 0 ? { externalDevices: [...devices] } : {};
}

/** Map a provision-path error into a typed reconcile failure. */
export function provisionFailure(error: unknown): BindingReconcileFailure {
  if (error instanceof BootCapacityExhaustedError) {
    return failure("capacity_exhausted", error.message, {
      capacity: {
        limit: error.limit,
        booted: error.booted,
        retryAfterMs: error.retryAfterMs,
        ...externalDevicesField(error.details.externalDevices),
        ...(error.details.heldDevices?.length
          ? { heldDevices: [...error.details.heldDevices] }
          : {}),
      },
    });
  }
  if (error instanceof ProvisionDeviceError) {
    if (error.code === "discovery_incomplete") {
      return failure("discovery_incomplete", error.message);
    }
    if (error.code === "runtime_incompatible") {
      return failure("runtime_incompatible", error.message);
    }
    const capacity = error.diagnostics.capacity;
    if (error.code === "capacity_exhausted" && capacity) {
      return failure("capacity_exhausted", error.message, {
        capacity: {
          limit: capacity.limit,
          booted: capacity.booted,
          retryAfterMs: error.diagnostics.retryAfterMs ?? 0,
          ...externalDevicesField(capacity.externalDevices),
          ...(capacity.heldDevices?.length ? { heldDevices: [...capacity.heldDevices] } : {}),
        },
      });
    }
    return failure("provision_failed", error.message, {
      retryable: error.retryable,
      provision: { code: error.code, retryable: error.retryable },
    });
  }
  return failure("provision_failed", errorMessage(error), { retryable: false });
}

export function expectationOf(assignment: BindingAssignmentRecord): BindingBindingExpectation {
  return { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId };
}

export interface ReconcileContext {
  request: BindingReconcileRequest;
  resolvedSpec: BindingResolvedSpec;
  fingerprint: BindingSpecFingerprint;
  evidence: BindingReconcileEvidence;
  creatabilityChecked?: boolean;
}

/**
 * The context an empty binding's create path runs under: its request deadline moves up to the
 * caller's create deadline, if any, so the warm readiness retry reserve is spent only by a create
 * (#14643). Adoption and reuse keep the request's full deadline.
 */
export function withCreateDeadline(context: ReconcileContext): ReconcileContext {
  const { createDeadlineMs, deadlineMs } = context.request;
  if (createDeadlineMs === undefined || createDeadlineMs >= deadlineMs) {
    return context;
  }
  return { ...context, request: { ...context.request, deadlineMs: createDeadlineMs } };
}

export type ReadyResult = Extract<BindingReconcileResult, { outcome: "ready" }>;
