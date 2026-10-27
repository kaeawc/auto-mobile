import type { BindingBudgetEvidence } from "./acquisitionResult";

export type BindingReconcileFailureCode =
  | "spec_unsupported"
  | "runtime_incompatible"
  | "scope_not_valid"
  | "discovery_incomplete"
  | "binding_in_use"
  | "binding_settling"
  | "device_busy"
  | "reconcile_in_progress"
  | "cleanup_pending"
  | "cleanup_quarantined"
  | "capacity_exhausted"
  | "binding_budget_exhausted"
  | "concurrent_modification"
  | "readiness_incomplete"
  | "stale_session"
  | "provision_failed"
  | "timeout"
  | "cancelled";

export interface BindingReconcileFailure {
  code: BindingReconcileFailureCode;
  retryable: boolean;
  message: string;
  nextAction: string;
  /** Underlying provision failure, when the provision path refused. */
  provision?: { code: string; retryable: boolean };
  retainedDevice?: { platform: "android" | "ios"; stableId: string; name: string };
  capacity?: BindingFailureCapacity;
  budget?: BindingBudgetEvidence;
}

/** Same `externalDevices` name and shape as the non-binding `capacity_exhausted` refusal (#11390). */
export interface BindingFailureCapacity {
  limit: number;
  booted: number;
  retryAfterMs: number;
  externalDevices?: string[];
  heldDevices?: string[];
}

export class ReconcileAbort extends Error {
  constructor(readonly failure: BindingReconcileFailure) {
    super(failure.message);
    this.name = "ReconcileAbort";
  }
}
