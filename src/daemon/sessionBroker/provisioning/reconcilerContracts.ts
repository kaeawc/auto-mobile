import type {
  BootSlotReservation,
  BootReservationOptions,
} from "../../../devices/bootAdmission/BootSlotReservation";
import type {
  AndroidDeviceSpecification,
  ResolvedExactDeviceSpecification,
} from "../../../devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../models/index";
import type { BackoffInput } from "../../../utils/Backoff";
import { type IdGenerator } from "../../../utils/IdGenerator";
import type { Timer } from "../../../utils/SystemTimer";
import { currentDaemonProcessGenerationToken } from "../../processGeneration";
import {
  type BindingJournalInFlight,
  type BindingJournalOwnerLiveness,
  type BindingJournalRedriveRecord,
} from "../registry/bindingJournal";
import type {
  BindingAssignmentRecord,
  BindingExecOwner,
  BindingExecOwnerLiveness,
  BindingJournalEntry,
  BindingJournalOwner,
  BindingKey,
  BindingPlatform,
  BindingRegistry,
} from "../registry/bindingRegistry";
import { type InFlightBindingReservations } from "../registry/ownerLiveness";
import {
  type BindingRequestedSpec,
  type ManagedSpecMatch,
  type ManagedSpecMatcher,
} from "./DefaultManagedSpecMatcher";
import {
  type BindingSpecFingerprint,
  type ManagedSpecResolver,
} from "./DefaultManagedSpecResolver";
import { type BindingReconcileFailure } from "./ReconcileAbort";
import type { BindingResourceBudget } from "./resourceBudget";

/** `adopted` is retained for wire compatibility; orphans are journaled replacements (#14788). */
export type BindingDisposition = "reused" | "adopted" | "created" | "replaced";

/** Known device metadata; an Android AVD may have no configured hardware profile. */
export interface BindingResolvedSpec {
  runtime: string;
  deviceType?: string;
  displayCutout?: ResolvedExactDeviceSpecification["displayCutout"];
  configuration?: AndroidDeviceSpecification["configuration"];
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

export interface BindingInventorySnapshot {
  /** False when any part of discovery failed; a missing device then proves nothing. */
  complete: boolean;
  /**
   * Set only when this platform's lister is verifiably not installed on the host. Complete
   * stays false: a specific device's absence is not proven. Only the total-resource budget
   * consumes this evidence, treating the platform as contributing zero inventory orphans.
   */
  toolchain?: "not_installed";
  devices: DeviceInfo[];
}

/** Configured (not only booted) devices of one platform: AVDs or simulators. */
export interface BindingInventory {
  /** Resolve a running AVD image's adb serial only when replacement needs its freed slot. */
  runtimeDeviceId?(
    device: DeviceInfo,
    options: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  list(
    platform: BindingPlatform,
    options: { signal?: AbortSignal },
  ): Promise<BindingInventorySnapshot>;
}

export interface BindingProvisionRequest {
  platform: BindingPlatform;
  /** Android: the AVD name (stable id). iOS: the simulator name. */
  name: string;
  /** iOS UDID of an assigned simulator to reuse. */
  deviceId?: string;
  /**
   * `create` always carries a concrete `deviceType` (the resolved model). `adopt` carries the
   * requested spec, whose omitted `deviceType` accepts the existing device's model.
   * Neither mode carries `deviceFamily`: the reconciler applies that request constraint before
   * provisioning, and the provisionDevice schema accepts configuration fields only.
   */
  spec: BindingRequestedSpec;
  /**
   * `adopt` reuses an assigned device and must never create; `create` provisions under `name`.
   * Unheld orphans are instead reclaimed by journaled delete-and-recreate (#14788), never unreset.
   */
  mode: "adopt" | "create";
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface BindingDeviceIdentity {
  /** AVD name or simulator UDID. */
  stableId: string;
  /** adb serial or UDID once booted. */
  transportId: string | null;
  name: string;
}

export interface BindingProvisionedDevice {
  device: BindingDeviceIdentity;
  created: boolean;
  sessionUuid: string;
  readiness: { mode: string; status: string };
  /** The provision handler's lifecycle/cleanup evidence, passed through. */
  lifecycle?: unknown;
}

/** Reads an existing device without applying the creation resolver's defaults. */
export interface BindingExistingSpecReader {
  /** The device's own metadata; null for unreadable config/runtime or an unknown iOS model. */
  readExistingSpec(device: DeviceInfo): Promise<BindingResolvedSpec | null>;
}

/**
 * The `provisionDevice` path with `readiness: "automation"`: exact matching, creation, boot,
 * session bind and its own rollback of partial creations (#11125, #11182). Throws
 * `ProvisionDeviceError` or `BootCapacityExhaustedError` on failure.
 */
export interface BindingDeviceProvisioner extends BindingExistingSpecReader {
  provision(request: BindingProvisionRequest): Promise<BindingProvisionedDevice>;
  /** Release a session this reconciler obtained but could not publish. */
  releaseSession(sessionUuid: string): Promise<void>;
}

export interface BindingDeletionTarget {
  platform: BindingPlatform;
  stableId: string;
  name: string | null;
  deadlineMs: number;
  signal?: AbortSignal;
}

export type BindingDeletionResult =
  | { kind: "absent"; evidence?: unknown }
  | {
      kind: "failed";
      message: string;
      evidence?: unknown;
      notAttempted?: {
        reason:
          | "workflow_unavailable"
          | "device_assigned_to_binding"
          | "device_owned_by_other_session"
          | "device_owned_by_other_daemon"
          | "inventory_incomplete"
          | "booted_inventory_incomplete"
          | "target_identity_conflict"
          | "target_identity_unresolved"
          | "target_not_destroyable";
      };
    };

/** The verified permanent delete workflow (`deleteDevice`: stop, destroy, verify absence). */
export interface BindingDeviceDeleter {
  deleteAndVerifyAbsence(target: BindingDeletionTarget): Promise<BindingDeletionResult>;
}

export type BindingDeviceClaim =
  | { kind: "free" }
  | { kind: "held"; reason: string }
  | { kind: "unknown"; reason: string };

/** Live sessions and foreign-daemon claims on a device, checked before destructive work. */
export interface BindingDeviceClaims {
  describe(device: DeviceInfo): Promise<BindingDeviceClaim>;
  /**
   * The sessions this daemon holds on the device. Before a binding device is provisioned for a new
   * execution, any of these is a leftover of an earlier one: the provision path's bind would hand
   * it out again (bind-or-reuse), so it is released first and never reused.
   */
  sessionsOn?(device: DeviceInfo): string[];
  /**
   * Whether a session on the device is a live managed execution this daemon still holds (#11275).
   * Such a session is never an earlier execution's leftover, whatever the registry's recorded
   * owner says (a restart can leave it naming a dead daemon): the binding is in use.
   */
  isLiveExecution?(sessionUuid: string): boolean;
}

export type BindingCapacityCheck =
  | { kind: "available" }
  | {
      kind: "exhausted";
      limit: number;
      booted: number;
      retryAfterMs: number;
      /** Counted devices AutoMobile did not start; present only when there are any (#11390). */
      externalDevices?: string[];
      heldDevices?: string[];
    }
  /** The booted count could not be established; never read as free capacity. */
  | { kind: "unknown"; message: string };

/** Immediate boot capacity probe (no waiting). Absent means boots are not gated. */
export type BindingBootReservation =
  | { kind: "available"; reservation: BootSlotReservation }
  | Exclude<BindingCapacityCheck, { kind: "available" }>;

export interface BindingBootReservationOptions extends BootReservationOptions {
  /** Runtime discovery shares the capacity reservation's deadline and cancellation. */
  resolveReplacingDeviceId?: (options: { signal?: AbortSignal }) => Promise<string | undefined>;
}

export interface BindingBootCapacity {
  reserve(
    platform: BindingPlatform,
    options: BindingBootReservationOptions,
  ): Promise<BindingBootReservation>;
  check(
    platform: BindingPlatform,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<BindingCapacityCheck>;
}

export interface BindingReconcilerDependencies {
  registry: BindingRegistry;
  inventory: BindingInventory;
  matcher: ManagedSpecMatcher;
  resolver: ManagedSpecResolver;
  provisioner: BindingDeviceProvisioner;
  deleter: BindingDeviceDeleter;
  claims: BindingDeviceClaims;
  capacity?: BindingBootCapacity;
  resourceBudget?: BindingResourceBudget;
  isBusy?: (device: DeviceInfo) => string | undefined;
  /** Whether a recorded execution owner is alive; default: PID plus process generation. */
  isExecOwnerLive?: BindingExecOwnerLiveness;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  /** Execution-reservation ids (default: random UUIDs). */
  idGenerator?: IdGenerator;
  /** Reservations in flight, which the registry's owner liveness reads (default: process-wide). */
  reservations?: Pick<InFlightBindingReservations, "add" | "delete">;
  /** Journal ownership and redrive policy (#11179). */
  journal?: BindingReconcilerJournalOptions;
}

export interface BindingReconcilerJournalOptions {
  /** This process as a journal owner; default: this PID and its process-generation token. */
  owner?: BindingJournalOwner;
  /** Whether another journal owner is alive; default: PID plus process generation. */
  isOwnerLive?: BindingJournalOwnerLiveness;
  /** Shared with the drain and the redrive pass so one process never drives an entry twice. */
  inFlight?: BindingJournalInFlight;
  backoff?: BackoffInput;
}

/** The default journal owner: this process, by PID and process-generation token. */
export function processJournalOwner(): BindingJournalOwner {
  return {
    daemonId: `pid-${process.pid}`,
    pid: process.pid,
    processGenerationToken: currentDaemonProcessGenerationToken() ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Request and result
// ---------------------------------------------------------------------------------------------

export interface BindingReconcileRequest {
  key: BindingKey;
  role: string;
  platform: BindingPlatform;
  requestedSpec: BindingRequestedSpec;
  /** Non-authoritative: preferred among orphan reclaim candidates, never trusted for deletion. */
  priorDeviceHint?: { stableId: string };
  /** Absolute deadline on the timer's clock for the whole preparation. */
  deadlineMs: number;
  /**
   * Earlier absolute deadline for creating a device into an empty binding, leaving the caller a
   * warm readiness retry window. Adoption and reuse keep `deadlineMs`, so the reserve is spent
   * only once the create path is actually chosen.
   */
  createDeadlineMs?: number;
  signal?: AbortSignal;
  /**
   * The execution the prepared device is for. When set, the reconciler claims the binding for it
   * atomically with the outcome: an assigned device is reserved BEFORE it is provisioned (so no
   * concurrent replacement can mark it while a session is being bound), and the ready result
   * names this owner with the provisioned session. Without it the caller claims afterwards.
   */
  owner?: Omit<BindingExecOwner, "sessionUuid">;
}

export interface BindingReconcileEvidence {
  /** Assignment as read before any mutation (null when the scope was not valid). */
  initial: { generation: number; stableDeviceId: string | null; state: string } | null;
  inventoryComplete: boolean | null;
  /** Match verdict for the assigned device, when one was present. */
  assignedMatch?: ManagedSpecMatch;
  assignedMissing?: boolean;
  /** The replacement reclaimed an orphan by journaled delete-and-recreate (#14788). */
  adoptedFrom?: "orphan";
  createdName?: string;
  deletedStableId?: string;
  deletion?: unknown;
  /** Device created by this attempt that could not be committed, and what happened to it. */
  uncommittedCleanup?: { stableId: string; removed: boolean; message?: string };
  /** Unfinished journaled work of an earlier attempt this acquisition redrove first (#11179). */
  redriven?: BindingJournalRedriveRecord[];
  /** The journal entry this attempt opened, and the phase it reached. */
  journal?: {
    entryId: number;
    kind: BindingJournalEntry["kind"];
    phase: BindingJournalEntry["phase"];
  };
  /** Leftover sessions of earlier executions released before provisioning, so none is reused. */
  releasedStaleSessions?: string[];
}

export type BindingReconcileResult =
  | {
      outcome: "ready";
      disposition: BindingDisposition;
      assignment: BindingAssignmentRecord;
      device: BindingDeviceIdentity;
      sessionUuid: string;
      requestedSpec: BindingRequestedSpec;
      resolvedSpec: BindingResolvedSpec;
      specFingerprint: BindingSpecFingerprint;
      readiness: { mode: string; status: string };
      lifecycle?: unknown;
      evidence: BindingReconcileEvidence;
    }
  | {
      outcome: "failed";
      failure: BindingReconcileFailure;
      /** The binding's assignment after the attempt (consistent, possibly changed). */
      assignment: BindingAssignmentRecord | null;
      evidence: BindingReconcileEvidence;
    };

export function bindingId(key: BindingKey): string {
  return `${key.scopeKey}#${key.bindingIndex}`;
}
