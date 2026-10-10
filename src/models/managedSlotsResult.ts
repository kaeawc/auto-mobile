/**
 * The managed-slot acquisition result (epic #11172, #11173 part b): what `daemon/acquireManagedSlots`
 * returns, and what the stdio proxy exposes verbatim in
 * `InitializeResult.capabilities.experimental["automobile/managedSlots"]` and as the proxy-local
 * resource {@link MANAGED_SLOTS_RESOURCE_URI}.
 *
 * Plain data only, shared by the daemon and the proxy, so neither imports the other's machinery.
 */

/** Proxy-local MCP resource carrying the acquisition result. */
export const MANAGED_SLOTS_RESOURCE_URI = "automobile:managed-slots";

export type ManagedSlotsOutcome = "ready" | "failed";

export type ManagedSlotDispositionName = "created" | "reused" | "adopted" | "replaced";

/**
 * Typed failure. `code` is either a reconciler code (`discovery_incomplete`, `slot_in_use`,
 * `capacity_exhausted`, ...) or an acquisition-level one:
 *
 * - `contract_unsupported`: the daemon does not advertise `managed-slots/v1`.
 * - `scope_invalidated`: this runner incarnation was reset; it never accepts work again.
 * - `scope_transition_pending`: a newer incarnation is waiting for the old one's owners/cleanup.
 * - `execution_policy_failed`: the session could not be put on the managed-execution policy.
 * - `execution_hold_failed`: the proxy could not hold a slot session for the execution.
 * - `daemon_unavailable`: the proxy could not reach the daemon within the preparation deadline.
 * - `timeout` / `cancelled`: the preparation deadline passed, or the proxy is shutting down.
 */
export const MANAGED_SLOT_ACQUISITION_OWN_FAILURE_CODES = [
  "managed_slot_config_invalid",
  "contract_unsupported",
  "managed_slot_group_unsupported",
  "managed_slots_unsupported",
  "scope_invalidated",
  "scope_transition_pending",
  "execution_policy_failed",
  "execution_hold_failed",
  "liveness_owner_conflict",
  "daemon_unavailable",
  "timeout",
  "cancelled",
] as const;

/** Failure codes the acquisition and the proxy mint themselves, beside the reconciler's. */
export type ManagedSlotAcquisitionOwnFailureCode =
  (typeof MANAGED_SLOT_ACQUISITION_OWN_FAILURE_CODES)[number];

export interface ManagedSlotsFailure {
  code: string;
  retryable: boolean;
  message: string;
  nextAction: string;
  /** Boot-capacity details of a `capacity_exhausted` slot failure (#11390). */
  capacity?: { limit: number; booted: number; retryAfterMs: number; externalDevices?: string[] };
}

export interface ManagedSlotDeviceEvidence {
  /** AVD name or simulator UDID. */
  stableId: string;
  /** adb serial or UDID once booted. */
  transportId: string | null;
  name: string;
}

export interface ManagedSlotResultEntry {
  slotIndex: number;
  role: string;
  platform: "android" | "ios";
  /** The slot's assignment generation after this acquisition (null when the slot was never read). */
  assignmentGeneration: number | null;
  device: ManagedSlotDeviceEvidence | null;
  /** The fresh session this execution holds on the slot's device (null when the slot failed). */
  sessionUuid: string | null;
  requestedSpec: unknown;
  resolvedSpec: unknown;
  specFingerprint: { version: number; hash: string } | null;
  disposition: ManagedSlotDispositionName | null;
  readiness: { mode: string; status: string } | null;
  /** The provision path's lifecycle/cleanup evidence and the reconciler's decision trail. */
  lifecycle: unknown;
  failure?: ManagedSlotsFailure;
}

export interface ManagedSlotsResult {
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
  outcome: ManagedSlotsOutcome;
  /** The idle window the slot sessions are held with (2-minute default or the config override). */
  idleTimeoutMs?: number;
  slots: ManagedSlotResultEntry[];
  /** Scope- or transport-level failure; per-slot failures sit on the slot entry. */
  failure?: ManagedSlotsFailure;
}

/** The sessions a ready result asks the proxy to hold. */
export function managedSlotSessions(result: ManagedSlotsResult): string[] {
  return result.outcome === "ready"
    ? result.slots.flatMap((slot) => (slot.sessionUuid ? [slot.sessionUuid] : []))
    : [];
}
