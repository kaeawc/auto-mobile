import type { BindingPlatform } from "../registry/bindingRegistry";

export type BindingsOutcome = "ready" | "failed";

export type BindingDispositionName = "created" | "reused" | "adopted" | "replaced";

/**
 * Typed failure. `code` is either a reconciler code (`discovery_incomplete`, `binding_in_use`,
 * `capacity_exhausted`, ...) or an acquisition-level one:
 *
 * - `contract_unsupported`: a legacy caller requested an unsupported contract.
 * - `registry_schema_unsupported`: a newer daemon migrated the shared registry beyond this build's schema.
 * - `scope_invalidated`: this runner incarnation was reset; it never accepts work again.
 * - `scope_transition_pending`: a newer incarnation is waiting for the old one's owners/cleanup.
 * - `execution_policy_failed`: the session could not be put on the managed-execution policy.
 * - `execution_hold_failed`: the proxy could not hold a binding session for the execution.
 * - `daemon_unavailable`: the proxy could not reach the daemon within the preparation deadline.
 * - `timeout` / `cancelled`: the preparation deadline passed, or the proxy is shutting down.
 */
export const BROKER_DEVICE_ACQUISITION_OWN_FAILURE_CODES = [
  "binding_config_invalid",
  "registry_schema_unsupported",
  "scope_invalidated",
  "scope_transition_pending",
  "execution_policy_failed",
  "liveness_owner_conflict",
  "timeout",
  "cancelled",
] as const;

/** Failure codes the acquisition and the proxy mint themselves, beside the reconciler's. */
export type BrokerDeviceAcquisitionOwnFailureCode =
  (typeof BROKER_DEVICE_ACQUISITION_OWN_FAILURE_CODES)[number];

/** Plain total-resource admission evidence, shared by daemon and proxy. */
export interface BindingBudgetEvidence {
  limit: number;
  usage: {
    total: number;
    active: number;
    assignedIdle: number;
    preparing: number;
    deleting: number;
    orphaned: number;
  };
  charged: Array<{
    platform: BindingPlatform;
    stableDeviceId: string;
    kind:
      | "assigned_active"
      | "assigned_idle"
      | "free"
      | "deleting"
      | "deletion_stuck"
      | "preparing"
      | "orphaned";
    uncounted?: true;
    /** Inventory name of the device (orphans), when it differs from `stableDeviceId`. */
    name?: string;
    /** Why an `orphaned` device is charged: it is running, or (iOS) booting or shutting down. */
    orphanState?: "running" | "transitioning";
  }>;
  /** Charged devices beyond the bounded `charged` list; `usage.total` is always the full count. */
  chargedOmitted?: number;
  retained: Array<{
    platform: BindingPlatform;
    stableDeviceId: string;
    reason: string;
    attempts?: number;
    failedDeletes?: number;
    uncounted?: true;
    lastError?: string | null;
  }>;
  evictionFailures: Array<{ platform: BindingPlatform; stableDeviceId: string; message: string }>;
}

export interface BindingsFailure {
  /** Internal evidence for prepare-path readiness retry; never included in broker receipts. */
  retainedDevice?: { platform: "android" | "ios"; stableId: string; name: string };
  provision?: { code: string; retryable: boolean };
  code: string;
  retryable: boolean;
  message: string;
  nextAction: string;
  /** Boot-capacity details of a `capacity_exhausted` binding failure (#11390). */
  capacity?: {
    limit: number;
    booted: number;
    retryAfterMs: number;
    externalDevices?: string[];
    heldDevices?: string[];
  };
  /** Total-resource refusal evidence; retryable, without a bounded retry delay. */
  budget?: BindingBudgetEvidence;
}

export interface BindingDeviceEvidence {
  /** AVD name or simulator UDID. */
  stableId: string;
  /** adb serial or UDID once booted. */
  transportId: string | null;
  name: string;
}

export interface BindingResultEntry {
  bindingIndex: number;
  role: string;
  platform: BindingPlatform;
  /** The binding's assignment generation after this acquisition (null when the binding was never read). */
  assignmentGeneration: number | null;
  device: BindingDeviceEvidence | null;
  /** The fresh session this execution holds on the binding's device (null when the binding failed). */
  sessionUuid: string | null;
  requestedSpec: unknown;
  resolvedSpec: unknown;
  specFingerprint: { version: number; hash: string } | null;
  disposition: BindingDispositionName | null;
  readiness: { mode: string; status: string } | null;
  /** The provision path's lifecycle/cleanup evidence and the reconciler's decision trail. */
  lifecycle: unknown;
  failure?: BindingsFailure;
}

export interface BindingsResult {
  contractVersion: 1;
  scope: {
    managedHostScope: string;
    runnerNamespace: string;
    runnerIncarnation: string;
    /** Null when the acquisition failed before the scope was resolved. */
    scopeKey: string | null;
    /** This acquisition reactivated a scope that had been abandoned (owner decision 2026-10-09). */
    revived?: boolean;
  };
  outcome: BindingsOutcome;
  /** The stored idle window (2-minute default or override); live-owned executions are idle-exempt. */
  idleTimeoutMs?: number;
  bindings: BindingResultEntry[];
  /** Scope- or transport-level failure; per-binding failures sit on the binding entry. */
  failure?: BindingsFailure;
}
