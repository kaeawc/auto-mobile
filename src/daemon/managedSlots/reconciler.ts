import { createHash } from "node:crypto";
import {
  evaluateIosPairCompatibility,
  iosDeviceSpecificationMismatch,
  matchesAndroidDeviceSpecification,
  resolveDisplayCutoutPreference,
} from "../../devices/deviceSpecMatching";
import {
  ProvisionDeviceError,
  type AndroidDeviceSpecification,
  type ExactDeviceSpecification,
  type ExactIosRuntimeCatalog,
  type IosDeviceSpecification,
  type ResolvedExactDeviceSpecification,
} from "../../devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../models";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { AvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { stableStringify } from "../../utils/stableStringify";
import type { Timer } from "../../utils/SystemTimer";
import {
  bindingMatches,
  type SlotAssignmentRecord,
  type SlotBindingExpectation,
  type SlotCasFailure,
  type SlotExecOwner,
  type SlotExecOwnerLiveness,
  type SlotKey,
  type SlotPlatform,
  type SlotRegistry,
} from "./slotRegistry";

/**
 * Declarative spec reconciler for one managed device slot (#11175, epic #11172).
 *
 * Given a scoped slot, a requested spec, the host-wide slot registry and the device inventory, it
 * decides between four dispositions and carries the decision out:
 *
 * - `reused`: the slot's assigned device satisfies the spec; it gets a fresh session.
 * - `adopted`: an empty slot takes a matching device that no valid slot holds (the free pool of
 *   invalidated scopes, or this slot's own uncommitted leftover from an interrupted create).
 * - `created`: no eligible device; a new one is provisioned under a generated name.
 * - `replaced`: the assigned device does not satisfy the spec; it is deleted, its absence is
 *   verified, a new one is created, and the result is committed into the same slot.
 *
 * Safety rules:
 * - Omitted spec fields are unconstrained (owner decision Q4); the resolved spec is recorded.
 * - Only this slot's own assigned device is ever deleted, and only after the spec is resolved,
 *   discovery is complete, no live owner or claim holds it and the slot binding still holds.
 * - Partial inventory or an unreadable device configuration is never authoritative absence or
 *   mismatch; it fails retryable `discovery_incomplete` without destructive work.
 * - Every registry mutation compare-and-sets `(generation, stableDeviceId)`, so a lost race never
 *   overwrites a newer binding. A deletion that fails leaves the old binding as `cleanup_pending`;
 *   a creation that fails after a verified deletion leaves the slot empty (`provisioning`).
 * - Boot capacity fails immediately with retryable `capacity_exhausted` (owner decision): the
 *   reconciler never waits for capacity and never creates a device it could not boot.
 *
 * Not yet wired into the acquire RPC (step 5 of the epic); callers inject the ports below.
 */

export const MANAGED_SLOT_SPEC_FINGERPRINT_VERSION = 1;
/** Generated device names start with this; a prefix alone is never deletion authority. */
export const MANAGED_SLOT_DEVICE_NAME_PREFIX = "amslot-";

export interface ManagedSlotSpecFingerprint {
  version: typeof MANAGED_SLOT_SPEC_FINGERPRINT_VERSION;
  hash: string;
}

export type ManagedSlotDisposition = "reused" | "adopted" | "created" | "replaced";

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

export interface ManagedSlotInventorySnapshot {
  /** False when any part of discovery failed; a missing device then proves nothing. */
  complete: boolean;
  devices: DeviceInfo[];
}

/** Configured (not only booted) devices of one platform: AVDs or simulators. */
export interface ManagedSlotInventory {
  list(
    platform: SlotPlatform,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSlotInventorySnapshot>;
}

/** `unknown` means the device's configuration could not be read; it never justifies deletion. */
export type ManagedSpecMatch = "match" | "mismatch" | "unknown";

export interface ManagedSpecMatcher {
  matches(device: DeviceInfo, spec: ExactDeviceSpecification): Promise<ManagedSpecMatch>;
}

export type ManagedSpecResolution =
  | {
      kind: "resolved";
      resolvedSpec: ResolvedExactDeviceSpecification;
      fingerprint: ManagedSlotSpecFingerprint;
    }
  | { kind: "unsupported"; code: "spec_unsupported" | "runtime_incompatible"; message: string };

/** Validates and resolves a spec before any destructive work. */
export interface ManagedSpecResolver {
  resolve(
    platform: SlotPlatform,
    spec: ExactDeviceSpecification,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecResolution>;
}

export interface ManagedSlotProvisionRequest {
  platform: SlotPlatform;
  /** Android: the AVD name (stable id). iOS: the simulator name. */
  name: string;
  /** iOS UDID of an existing simulator to adopt. */
  deviceId?: string;
  spec: ExactDeviceSpecification;
  /** `adopt` must never create; `create` provisions a new device under `name`. */
  mode: "adopt" | "create";
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface ManagedSlotDeviceIdentity {
  /** AVD name or simulator UDID. */
  stableId: string;
  /** adb serial or UDID once booted. */
  transportId: string | null;
  name: string;
}

export interface ManagedSlotProvisionedDevice {
  device: ManagedSlotDeviceIdentity;
  created: boolean;
  sessionUuid: string;
  readiness: { mode: string; status: string };
  /** The provision handler's lifecycle/cleanup evidence, passed through. */
  lifecycle?: unknown;
}

/**
 * The `provisionDevice` path with `readiness: "automation"`: exact matching, creation, boot,
 * session bind and its own rollback of partial creations (#11125, #11182). Throws
 * `ProvisionDeviceError` or `BootCapacityExhaustedError` on failure.
 */
export interface ManagedSlotDeviceProvisioner {
  provision(request: ManagedSlotProvisionRequest): Promise<ManagedSlotProvisionedDevice>;
  /** Release a session this reconciler obtained but could not publish. */
  releaseSession(sessionUuid: string): Promise<void>;
}

export interface ManagedSlotDeletionTarget {
  platform: SlotPlatform;
  stableId: string;
  name: string | null;
  deadlineMs: number;
  signal?: AbortSignal;
}

export type ManagedSlotDeletionResult =
  | { kind: "absent"; evidence?: unknown }
  | { kind: "failed"; message: string; evidence?: unknown };

/** The verified permanent delete workflow (`deleteDevice`: stop, destroy, verify absence). */
export interface ManagedSlotDeviceDeleter {
  deleteAndVerifyAbsence(target: ManagedSlotDeletionTarget): Promise<ManagedSlotDeletionResult>;
}

export type ManagedSlotDeviceClaim =
  | { kind: "free" }
  | { kind: "held"; reason: string }
  | { kind: "unknown"; reason: string };

/** Live sessions and foreign-daemon claims on a device, checked before destructive work. */
export interface ManagedSlotDeviceClaims {
  describe(device: DeviceInfo): Promise<ManagedSlotDeviceClaim>;
}

export type ManagedSlotCapacityCheck =
  | { kind: "available" }
  | { kind: "exhausted"; limit: number; booted: number; retryAfterMs: number };

/** Immediate boot capacity probe (no waiting). Absent means boots are not gated. */
export interface ManagedSlotBootCapacity {
  check(
    platform: SlotPlatform,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSlotCapacityCheck>;
}

export interface ManagedSlotReconcilerDependencies {
  registry: SlotRegistry;
  inventory: ManagedSlotInventory;
  matcher: ManagedSpecMatcher;
  resolver: ManagedSpecResolver;
  provisioner: ManagedSlotDeviceProvisioner;
  deleter: ManagedSlotDeviceDeleter;
  claims: ManagedSlotDeviceClaims;
  capacity?: ManagedSlotBootCapacity;
  /** Whether a recorded execution owner is alive; default treats every owner as live. */
  isExecOwnerLive?: SlotExecOwnerLiveness;
  timer: Pick<Timer, "now">;
  /** Execution-reservation ids (default: random UUIDs). */
  idGenerator?: IdGenerator;
}

// ---------------------------------------------------------------------------------------------
// Request and result
// ---------------------------------------------------------------------------------------------

export interface ManagedSlotReconcileRequest {
  key: SlotKey;
  role: string;
  platform: SlotPlatform;
  requestedSpec: ExactDeviceSpecification;
  /** Non-authoritative: preferred among adoption candidates, never trusted for deletion. */
  priorDeviceHint?: { stableId: string };
  /** Absolute deadline on the timer's clock for the whole preparation. */
  deadlineMs: number;
  signal?: AbortSignal;
  /**
   * The execution the prepared device is for. When set, the reconciler claims the slot for it
   * atomically with the outcome: an assigned device is reserved BEFORE it is provisioned (so no
   * concurrent replacement can mark it while a session is being bound), and the ready result
   * names this owner with the provisioned session. Without it the caller claims afterwards.
   */
  owner?: Omit<SlotExecOwner, "sessionUuid">;
}

export type ManagedSlotReconcileFailureCode =
  | "spec_unsupported"
  | "runtime_incompatible"
  | "scope_not_valid"
  | "slot_platform_conflict"
  | "discovery_incomplete"
  | "slot_in_use"
  | "device_busy"
  | "reconcile_in_progress"
  | "cleanup_pending"
  | "capacity_exhausted"
  | "concurrent_modification"
  | "readiness_incomplete"
  | "provision_failed"
  | "timeout"
  | "cancelled";

const FAILURE_RETRYABILITY: Readonly<Record<ManagedSlotReconcileFailureCode, boolean>> = {
  spec_unsupported: false,
  runtime_incompatible: false,
  scope_not_valid: false,
  slot_platform_conflict: false,
  discovery_incomplete: true,
  slot_in_use: true,
  device_busy: true,
  reconcile_in_progress: true,
  cleanup_pending: true,
  capacity_exhausted: true,
  concurrent_modification: true,
  readiness_incomplete: true,
  provision_failed: false,
  timeout: true,
  cancelled: true,
};

const FAILURE_NEXT_ACTION: Readonly<Record<ManagedSlotReconcileFailureCode, string>> = {
  spec_unsupported: "Fix the requested spec; nothing was changed.",
  runtime_incompatible: "Request a model/runtime pair the host supports; nothing was changed.",
  scope_not_valid: "Use the current runner incarnation; this scope no longer accepts work.",
  slot_platform_conflict: "Use a different slot index for a different platform.",
  discovery_incomplete: "Retry once device discovery completes; nothing destructive was done.",
  slot_in_use: "Wait for the slot's live execution to end, then retry.",
  device_busy: "Wait for the device's live session or foreign claim to end, then retry.",
  reconcile_in_progress: "Another reconciliation of this slot is in progress; retry later.",
  cleanup_pending: "The previous device could not be removed; retry after cleanup succeeds.",
  capacity_exhausted: "Shut down a device or raise the boot limit, then retry.",
  concurrent_modification: "The slot changed concurrently; retry to converge on its new state.",
  readiness_incomplete: "Retry; the device did not reach automation readiness.",
  provision_failed: "Inspect the provision failure code; retry if it is retryable.",
  timeout: "Retry with a longer preparation timeout.",
  cancelled: "The preparation was cancelled; retry when needed.",
};

export interface ManagedSlotReconcileFailure {
  code: ManagedSlotReconcileFailureCode;
  retryable: boolean;
  message: string;
  nextAction: string;
  /** Underlying provision failure, when the provision path refused. */
  provision?: { code: string; retryable: boolean };
  capacity?: { limit: number; booted: number; retryAfterMs: number };
}

export interface ManagedSlotReconcileEvidence {
  /** Assignment as read before any mutation (null when the scope was not valid). */
  initial: { generation: number; stableDeviceId: string | null; state: string } | null;
  inventoryComplete: boolean | null;
  /** Match verdict for the assigned device, when one was present. */
  assignedMatch?: ManagedSpecMatch;
  assignedMissing?: boolean;
  adoptedFrom?: "free_pool" | "orphan";
  createdName?: string;
  deletedStableId?: string;
  deletion?: unknown;
  /** Device created by this attempt that could not be committed, and what happened to it. */
  uncommittedCleanup?: { stableId: string; removed: boolean; message?: string };
}

export type ManagedSlotReconcileResult =
  | {
      outcome: "ready";
      disposition: ManagedSlotDisposition;
      assignment: SlotAssignmentRecord;
      device: ManagedSlotDeviceIdentity;
      sessionUuid: string;
      requestedSpec: ExactDeviceSpecification;
      resolvedSpec: ResolvedExactDeviceSpecification;
      specFingerprint: ManagedSlotSpecFingerprint;
      readiness: { mode: string; status: string };
      lifecycle?: unknown;
      evidence: ManagedSlotReconcileEvidence;
    }
  | {
      outcome: "failed";
      failure: ManagedSlotReconcileFailure;
      /** The slot's assignment after the attempt (consistent, possibly changed). */
      assignment: SlotAssignmentRecord | null;
      evidence: ManagedSlotReconcileEvidence;
    };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** `amslot-<8 hex of scope key>-<slot>-g<generation>`, valid as an AVD and simulator name. */
export function managedSlotDeviceName(key: SlotKey, generation: number): string {
  return `${managedSlotDeviceNamePrefix(key)}${generation}`;
}

function managedSlotDeviceNamePrefix(key: SlotKey): string {
  return `${MANAGED_SLOT_DEVICE_NAME_PREFIX}${key.scopeKey.slice(0, 8)}-${key.slotIndex}-g`;
}

export function computeManagedSpecFingerprint(
  platform: SlotPlatform,
  resolvedSpec: ResolvedExactDeviceSpecification,
): ManagedSlotSpecFingerprint {
  const hash = createHash("sha256")
    .update(
      stableStringify({ version: MANAGED_SLOT_SPEC_FINGERPRINT_VERSION, platform, resolvedSpec }),
    )
    .digest("hex");
  return { version: MANAGED_SLOT_SPEC_FINGERPRINT_VERSION, hash };
}

/** The registry column form of a fingerprint: `v<version>:<hash>`. */
export function encodeManagedSpecFingerprint(fingerprint: ManagedSlotSpecFingerprint): string {
  return `v${fingerprint.version}:${fingerprint.hash}`;
}

/** The stable resource id: AVD name on Android, UDID on iOS. */
export function deviceStableId(device: DeviceInfo): string | undefined {
  return device.platform === "android" ? device.name : device.deviceId;
}

/** Matches with the shared exact-provisioning matchers (#11100) — one definition of "matches". */
export class DefaultManagedSpecMatcher implements ManagedSpecMatcher {
  constructor(private readonly androidConfigReader: Pick<AvdConfigReader, "readConfig">) {}

  async matches(device: DeviceInfo, spec: ExactDeviceSpecification): Promise<ManagedSpecMatch> {
    if (device.platform === "android") {
      let config: Awaited<ReturnType<AvdConfigReader["readConfig"]>>;
      try {
        config = await this.androidConfigReader.readConfig(device.name);
      } catch (error) {
        logger.warn(
          `[ManagedSlots] cannot read AVD config for '${device.name}': ${errorMessage(error)}`,
          error,
        );
        return "unknown";
      }
      if (!config) {
        return "unknown";
      }
      return matchesAndroidDeviceSpecification(spec as AndroidDeviceSpecification, config)
        ? "match"
        : "mismatch";
    }
    // An unavailable simulator (runtime unmounted, or listed under a different Xcode or
    // DEVELOPER_DIR) proves nothing about its configuration, so it is never a mismatch to replace.
    if (
      device.isAvailable === false ||
      device.runtime === undefined ||
      device.deviceType === undefined
    ) {
      return "unknown";
    }
    return iosDeviceSpecificationMismatch(spec as IosDeviceSpecification, device) === undefined
      ? "match"
      : "mismatch";
  }
}

/**
 * Resolves a spec with the shared exact-provisioning checks: Android image identifier shape,
 * display cutout, and (with a catalog) a proven-incompatible iOS model/runtime pair. Unreadable
 * catalogs are unknown, not unsupported, matching the provisioner.
 */
export class DefaultManagedSpecResolver implements ManagedSpecResolver {
  constructor(private readonly iosRuntimeCatalog?: ExactIosRuntimeCatalog) {}

  async resolve(
    platform: SlotPlatform,
    spec: ExactDeviceSpecification,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecResolution> {
    if (platform === "android" && !parseAndroidSystemImageRuntime(spec.runtime)) {
      return {
        kind: "unsupported",
        code: "spec_unsupported",
        message: `Android runtime '${spec.runtime}' is not a system-image identifier.`,
      };
    }
    const cutout = resolveDisplayCutoutPreference(platform, spec);
    if (cutout.kind !== "resolved") {
      return { kind: "unsupported", code: "spec_unsupported", message: cutout.message };
    }
    if (platform === "ios" && this.iosRuntimeCatalog) {
      const incompatible = await this.findIosIncompatibility(spec, options.signal);
      if (incompatible) {
        return { kind: "unsupported", code: "runtime_incompatible", message: incompatible };
      }
    }
    const resolvedSpec = {
      ...spec,
      displayCutout: cutout.displayCutout,
    } as ResolvedExactDeviceSpecification;
    return {
      kind: "resolved",
      resolvedSpec,
      fingerprint: computeManagedSpecFingerprint(platform, resolvedSpec),
    };
  }

  private async findIosIncompatibility(
    spec: ExactDeviceSpecification,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const catalog = this.iosRuntimeCatalog!;
    let runtimes: Awaited<ReturnType<ExactIosRuntimeCatalog["getRuntimesChecked"]>>;
    let deviceTypes: Awaited<ReturnType<ExactIosRuntimeCatalog["getDeviceTypesChecked"]>>;
    try {
      [runtimes, deviceTypes] = await Promise.all([
        catalog.getRuntimesChecked(undefined, signal),
        catalog.getDeviceTypesChecked(signal),
      ]);
    } catch (error) {
      // An unreadable catalog is not proof of incompatibility; creation keeps simctl as authority.
      logger.warn(`[ManagedSlots] iOS catalog check skipped: ${errorMessage(error)}`, error);
      return undefined;
    }
    const incompatibility = evaluateIosPairCompatibility(spec, runtimes, deviceTypes);
    if (!incompatibility) {
      return undefined;
    }
    const alternatives =
      incompatibility.compatibleRuntimes.map((entry) => entry.id).join(", ") || "none installed";
    return incompatibility.unavailable
      ? `Runtime '${spec.runtime}' is not available. Compatible installed runtimes: ${alternatives}.`
      : `Device type '${spec.deviceType}' does not support runtime '${spec.runtime}'. Compatible installed runtimes: ${alternatives}.`;
  }
}

class ReconcileAbort extends Error {
  constructor(readonly failure: ManagedSlotReconcileFailure) {
    super(failure.message);
    this.name = "ReconcileAbort";
  }
}

function failure(
  code: ManagedSlotReconcileFailureCode,
  message: string,
  extra: Partial<Pick<ManagedSlotReconcileFailure, "provision" | "capacity" | "retryable">> = {},
): ManagedSlotReconcileFailure {
  return {
    code,
    retryable: extra.retryable ?? FAILURE_RETRYABILITY[code],
    message,
    nextAction: FAILURE_NEXT_ACTION[code],
    ...(extra.provision ? { provision: extra.provision } : {}),
    ...(extra.capacity ? { capacity: extra.capacity } : {}),
  };
}

function casFailure(result: SlotCasFailure, step: string): ManagedSlotReconcileFailure {
  switch (result.kind) {
    case "scope_not_valid":
      return failure("scope_not_valid", `Slot scope is no longer valid (${step}).`);
    case "slot_missing":
      return failure("concurrent_modification", `Slot disappeared during ${step}.`);
    case "stale_binding":
      return failure(
        "concurrent_modification",
        `Slot binding changed during ${step} (now generation ${result.current.generation}).`,
      );
    case "device_assigned_elsewhere":
      return failure(
        "concurrent_modification",
        `Device is already assigned to slot ${result.holder.slotIndex} of another scope (${step}).`,
      );
  }
}

/** A refused execution claim or fence, as a reconcile failure. */
function claimFailure(
  result: SlotCasFailure | { kind: "slot_in_use"; owner: SlotExecOwner } | { kind: "slot_not_ready" },
  step: string,
): ManagedSlotReconcileFailure {
  switch (result.kind) {
    case "slot_in_use":
      return failure(
        "slot_in_use",
        `Slot is held by live session ${result.owner.sessionUuid} (${step}).`,
      );
    case "slot_not_ready":
      return failure("concurrent_modification", `Slot stopped being ready during ${step}.`);
    default:
      return casFailure(result, step);
  }
}

/** Map a provision-path error into a typed reconcile failure. */
function provisionFailure(error: unknown): ManagedSlotReconcileFailure {
  if (error instanceof BootCapacityExhaustedError) {
    return failure("capacity_exhausted", error.message, {
      capacity: { limit: error.limit, booted: error.booted, retryAfterMs: error.retryAfterMs },
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

function slotId(key: SlotKey): string {
  return `${key.scopeKey}#${key.slotIndex}`;
}

function expectationOf(assignment: SlotAssignmentRecord): SlotBindingExpectation {
  return { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId };
}

interface ReconcileContext {
  request: ManagedSlotReconcileRequest;
  resolvedSpec: ResolvedExactDeviceSpecification;
  fingerprint: ManagedSlotSpecFingerprint;
  evidence: ManagedSlotReconcileEvidence;
}

type ReadyResult = Extract<ManagedSlotReconcileResult, { outcome: "ready" }>;

// ---------------------------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------------------------

export class ManagedSlotReconciler {
  /** Serializes reconciliations of one slot inside this process. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly isExecOwnerLive: SlotExecOwnerLiveness;
  private readonly idGenerator: IdGenerator;

  constructor(private readonly deps: ManagedSlotReconcilerDependencies) {
    this.isExecOwnerLive = deps.isExecOwnerLive ?? (() => true);
    this.idGenerator = deps.idGenerator ?? defaultIdGenerator;
  }

  async reconcile(request: ManagedSlotReconcileRequest): Promise<ManagedSlotReconcileResult> {
    const id = slotId(request.key);
    const previous = this.inFlight.get(id) ?? Promise.resolve();
    const run = previous.then(
      () => this.reconcileSerialized(request),
      () => this.reconcileSerialized(request),
    );
    this.inFlight.set(id, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(id) === run) {
        this.inFlight.delete(id);
      }
    }
  }

  private async reconcileSerialized(
    request: ManagedSlotReconcileRequest,
  ): Promise<ManagedSlotReconcileResult> {
    const evidence: ManagedSlotReconcileEvidence = { initial: null, inventoryComplete: null };
    try {
      return await this.reconcileSteps(request, evidence);
    } catch (error) {
      if (error instanceof ReconcileAbort) {
        return {
          outcome: "failed",
          failure: error.failure,
          assignment: await this.deps.registry.getAssignment(request.key),
          evidence,
        };
      }
      throw error;
    }
  }

  private async reconcileSteps(
    request: ManagedSlotReconcileRequest,
    evidence: ManagedSlotReconcileEvidence,
  ): Promise<ManagedSlotReconcileResult> {
    const { registry } = this.deps;
    this.checkBudget(request);
    // Resolve first: an unsupported spec fails before any registry or device mutation.
    const resolution = await this.deps.resolver.resolve(request.platform, request.requestedSpec, {
      signal: request.signal,
    });
    if (resolution.kind === "unsupported") {
      throw new ReconcileAbort(failure(resolution.code, resolution.message));
    }
    const context: ReconcileContext = {
      request,
      resolvedSpec: resolution.resolvedSpec,
      fingerprint: resolution.fingerprint,
      evidence,
    };

    const init = await registry.initSlot(request.key, {
      role: request.role,
      platform: request.platform,
      requestedSpec: request.requestedSpec,
    });
    if (init.kind === "scope_not_valid") {
      throw new ReconcileAbort(failure("scope_not_valid", "Slot scope is not valid."));
    }
    const assignment = init.assignment;
    evidence.initial = {
      generation: assignment.generation,
      stableDeviceId: assignment.stableDeviceId,
      state: assignment.state,
    };
    this.assertSlotAcceptsWork(request, assignment);

    const inventory = await this.deps.inventory.list(request.platform, { signal: request.signal });
    evidence.inventoryComplete = inventory.complete;
    this.checkBudget(request);

    if (assignment.stableDeviceId === null) {
      return await this.fillEmptySlot(context, assignment, inventory);
    }
    const assigned = inventory.devices.find(
      (device) =>
        device.platform === request.platform &&
        deviceStableId(device) === assignment.stableDeviceId,
    );
    if (!assigned) {
      if (!inventory.complete) {
        throw new ReconcileAbort(
          failure(
            "discovery_incomplete",
            `Assigned device '${assignment.stableDeviceId}' was not listed and discovery was incomplete.`,
          ),
        );
      }
      // Removed out of band: complete discovery proves absence, so create at generation + 1.
      evidence.assignedMissing = true;
      return await this.createAndCommit(context, assignment, "created");
    }
    const match = await this.deps.matcher.matches(assigned, request.requestedSpec);
    evidence.assignedMatch = match;
    if (match === "unknown") {
      throw new ReconcileAbort(
        failure(
          "discovery_incomplete",
          `Configuration of assigned device '${assignment.stableDeviceId}' could not be read.`,
        ),
      );
    }
    if (match === "match") {
      return await this.reuseAssigned(context, assignment, assigned);
    }
    return await this.replaceAssigned(context, assignment, assigned, inventory.complete);
  }

  private assertSlotAcceptsWork(
    request: ManagedSlotReconcileRequest,
    assignment: SlotAssignmentRecord,
  ): void {
    if (assignment.platform !== request.platform) {
      throw new ReconcileAbort(
        failure(
          "slot_platform_conflict",
          `Slot ${request.key.slotIndex} is a ${assignment.platform} slot; ${request.platform} was requested.`,
        ),
      );
    }
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      throw new ReconcileAbort(
        failure(
          "slot_in_use",
          `Slot ${request.key.slotIndex} is held by live session ${assignment.execOwner.sessionUuid}.`,
        ),
      );
    }
    if (assignment.state === "cleanup_pending") {
      throw new ReconcileAbort(
        failure(
          "cleanup_pending",
          `Slot ${request.key.slotIndex} still holds device '${assignment.stableDeviceId}' pending cleanup.`,
        ),
      );
    }
    if (assignment.state === "replacing") {
      // Redrive of an interrupted replacement belongs to the journal (#11179); never guess here.
      throw new ReconcileAbort(
        failure(
          "reconcile_in_progress",
          `Slot ${request.key.slotIndex} is mid-replacement of '${assignment.stableDeviceId}'.`,
        ),
      );
    }
  }

  // --- reuse -----------------------------------------------------------------------------------

  private async reuseAssigned(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    device: DeviceInfo,
  ): Promise<ReadyResult> {
    await this.assertBootCapacity(context.request, device);
    // Reserve the slot before binding a session to its device, so a concurrent replacement can
    // neither fence nor delete the device while this attempt provisions it.
    const reservation = await this.reserveExecution(context, assignment);
    try {
      return await this.reuseReserved(context, assignment, device, reservation);
    } catch (error) {
      if (reservation) {
        await this.releaseReservation(context.request.key, reservation);
      }
      throw error;
    }
  }

  private async reuseReserved(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    device: DeviceInfo,
    reservation: string | undefined,
  ): Promise<ReadyResult> {
    const provisioned = await this.provisionExisting(context, device);
    const expected = expectationOf(assignment);
    const fingerprint = encodeManagedSpecFingerprint(context.fingerprint);
    const unchanged =
      assignment.state === "ready" &&
      assignment.specFingerprint === fingerprint &&
      stableStringify(assignment.requestedSpec) === stableStringify(context.request.requestedSpec);
    // An unchanged ready binding is only re-verified; a new spec or a not-yet-ready binding is
    // recorded as a new generation of the same device.
    const committed = unchanged
      ? await this.deps.registry.updateSlotState(context.request.key, expected, "ready")
      : await this.deps.registry.commitBinding(context.request.key, expected, {
          stableDeviceId: assignment.stableDeviceId,
          deviceName: provisioned.device.name,
          requestedSpec: context.request.requestedSpec,
          resolvedSpec: context.resolvedSpec,
          specFingerprint: fingerprint,
          state: "ready",
        });
    if (committed.kind !== "updated" && committed.kind !== "committed") {
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(claimFailure(committed, "reuse"));
    }
    return await this.claimAndReady(
      context,
      "reused",
      committed.assignment,
      provisioned,
      reservation,
    );
  }

  /** Claim a ready, assigned slot for a placeholder session before provisioning, when owned. */
  private async reserveExecution(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
  ): Promise<string | undefined> {
    const { owner, key } = context.request;
    if (!owner || assignment.state !== "ready") {
      return undefined;
    }
    const reservation = `reserve-${this.idGenerator.next()}`;
    const claimed = await this.deps.registry.claimExecution(key, expectationOf(assignment), {
      ...owner,
      sessionUuid: reservation,
    });
    if (claimed.kind !== "claimed") {
      throw new ReconcileAbort(claimFailure(claimed, "reservation"));
    }
    return reservation;
  }

  private async releaseReservation(key: SlotKey, reservation: string): Promise<void> {
    try {
      await this.deps.registry.releaseExecution(key, reservation);
    } catch (error) {
      // A leaked reservation names this daemon's PID, so it blocks the slot only until this
      // process exits; log it so the stuck slot has a trace.
      logger.warn(
        `[ManagedSlots] releasing reservation ${reservation} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  // --- empty slot: adopt or create -------------------------------------------------------------

  private async fillEmptySlot(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    inventory: ManagedSlotInventorySnapshot,
  ): Promise<ReadyResult> {
    if (!inventory.complete) {
      // Without complete discovery we can neither find adoptable devices nor rule out a
      // leftover of this slot, so do nothing rather than create a duplicate.
      throw new ReconcileAbort(
        failure("discovery_incomplete", "Device discovery was incomplete for an empty slot."),
      );
    }
    const candidate = await this.findAdoptionCandidate(context, inventory.devices);
    if (candidate) {
      return await this.adopt(context, assignment, candidate.device, candidate.source);
    }
    return await this.createAndCommit(context, assignment, "created");
  }

  private async findAdoptionCandidate(
    context: ReconcileContext,
    devices: DeviceInfo[],
  ): Promise<{ device: DeviceInfo; source: "free_pool" | "orphan" } | undefined> {
    const { request } = context;
    const free = new Set(
      (await this.deps.registry.listFreeDevices())
        .filter((entry) => entry.platform === request.platform)
        .map((entry) => entry.stableDeviceId),
    );
    const prefix = managedSlotDeviceNamePrefix(request.key);
    const hint = request.priorDeviceHint?.stableId;
    const listed = devices
      .filter((device) => device.platform === request.platform)
      .map((device) => ({ device, stableId: deviceStableId(device) }))
      .filter((entry): entry is { device: DeviceInfo; stableId: string } => !!entry.stableId)
      .sort(
        (a, b) =>
          Number(b.stableId === hint) - Number(a.stableId === hint) ||
          a.stableId.localeCompare(b.stableId),
      );
    for (const { device, stableId } of listed) {
      const source = free.has(stableId)
        ? "free_pool"
        : device.name.startsWith(prefix)
          ? "orphan"
          : undefined;
      if (!source) {
        continue;
      }
      if (source === "orphan") {
        // A leftover of this slot's interrupted create is adoptable only if nobody holds it.
        const holder = await this.deps.registry.findDeviceHolder(request.platform, stableId);
        if (holder) {
          continue;
        }
      }
      if ((await this.deps.matcher.matches(device, request.requestedSpec)) === "match") {
        return { device, source };
      }
    }
    return undefined;
  }

  private async adopt(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    device: DeviceInfo,
    source: "free_pool" | "orphan",
  ): Promise<ReadyResult> {
    const { request } = context;
    const stableId = deviceStableId(device)!;
    await this.assertBootCapacity(request, device);
    // Commit first: the CAS atomically takes the device out of the free pool and reserves it,
    // so a failed provision leaves the slot bound (`provisioning`) and the next attempt reuses.
    const reserved = await this.deps.registry.commitBinding(
      request.key,
      expectationOf(assignment),
      {
        stableDeviceId: stableId,
        deviceName: device.name,
        requestedSpec: request.requestedSpec,
        resolvedSpec: context.resolvedSpec,
        specFingerprint: encodeManagedSpecFingerprint(context.fingerprint),
        state: "provisioning",
      },
    );
    if (reserved.kind !== "committed") {
      throw new ReconcileAbort(casFailure(reserved, "adoption"));
    }
    context.evidence.adoptedFrom = source;
    const provisioned = await this.provisionExisting(context, device);
    const ready = await this.deps.registry.updateSlotState(
      request.key,
      expectationOf(reserved.assignment),
      "ready",
    );
    if (ready.kind !== "updated") {
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(claimFailure(ready, "adoption"));
    }
    return await this.claimAndReady(context, "adopted", ready.assignment, provisioned, undefined);
  }

  private async createAndCommit(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    disposition: "created" | "replaced",
  ): Promise<ReadyResult> {
    const { request } = context;
    this.checkBudget(request);
    await this.assertBootCapacity(request, undefined);
    const name = managedSlotDeviceName(request.key, assignment.generation + 1);
    context.evidence.createdName = name;
    let provisioned: ManagedSlotProvisionedDevice;
    try {
      provisioned = await this.deps.provisioner.provision({
        platform: request.platform,
        name,
        spec: request.requestedSpec,
        mode: "create",
        deadlineMs: request.deadlineMs,
        signal: request.signal,
      });
    } catch (error) {
      // The provision path rolled back its own partial creation; the slot is unchanged.
      throw new ReconcileAbort(provisionFailure(error));
    }
    if (!this.isAutomationReady(provisioned)) {
      await this.discardUncommitted(context, provisioned);
      throw new ReconcileAbort(
        failure("readiness_incomplete", `Device '${name}' did not reach automation readiness.`),
      );
    }
    const committed = await this.deps.registry.commitBinding(
      request.key,
      expectationOf(assignment),
      {
        stableDeviceId: provisioned.device.stableId,
        deviceName: provisioned.device.name,
        requestedSpec: request.requestedSpec,
        resolvedSpec: context.resolvedSpec,
        specFingerprint: encodeManagedSpecFingerprint(context.fingerprint),
        state: "ready",
      },
    );
    if (committed.kind !== "committed") {
      await this.discardUncommitted(context, provisioned);
      throw new ReconcileAbort(casFailure(committed, "create commit"));
    }
    return await this.claimAndReady(
      context,
      disposition,
      committed.assignment,
      provisioned,
      undefined,
    );
  }

  /** A device this attempt created but could not publish: release its session and delete it. */
  private async discardUncommitted(
    context: ReconcileContext,
    provisioned: ManagedSlotProvisionedDevice,
  ): Promise<void> {
    await this.releaseSession(provisioned.sessionUuid);
    if (!provisioned.created) {
      return;
    }
    const { request } = context;
    const result = await this.deleteDevice({
      platform: request.platform,
      stableId: provisioned.device.stableId,
      name: provisioned.device.name,
      deadlineMs: request.deadlineMs,
      signal: request.signal,
    });
    context.evidence.uncommittedCleanup = {
      stableId: provisioned.device.stableId,
      removed: result.kind === "absent",
      ...(result.kind === "failed" ? { message: result.message } : {}),
    };
    if (result.kind === "failed") {
      // The leftover carries this slot's name prefix, so a later attempt can adopt it.
      logger.warn(
        `[ManagedSlots] uncommitted device '${provisioned.device.stableId}' was not removed: ${result.message}`,
      );
    }
  }

  // --- replace ---------------------------------------------------------------------------------

  private async replaceAssigned(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    device: DeviceInfo,
    inventoryComplete: boolean,
  ): Promise<ReadyResult> {
    const { request, evidence } = context;
    const { registry } = this.deps;
    const oldId = assignment.stableDeviceId!;
    await this.assertReplaceable(request, assignment, device, inventoryComplete);
    const marked = await registry.updateSlotState(
      request.key,
      expectationOf(assignment),
      "replacing",
    );
    if (marked.kind !== "updated") {
      // A live execution (or another attempt's reservation) claimed the device after our checks.
      throw new ReconcileAbort(claimFailure(marked, "replace"));
    }
    const deletion = await this.deleteDevice({
      platform: request.platform,
      stableId: oldId,
      name: assignment.deviceName,
      deadlineMs: request.deadlineMs,
      signal: request.signal,
    });
    evidence.deletion = deletion.evidence;
    if (deletion.kind === "failed") {
      // The old device may still exist: keep it bound and protected until cleanup succeeds.
      const pending = await registry.updateSlotState(
        request.key,
        expectationOf(marked.assignment),
        "cleanup_pending",
      );
      if (pending.kind !== "updated") {
        logger.warn(
          `[ManagedSlots] could not mark slot ${request.key.slotIndex} cleanup_pending: ${pending.kind}`,
        );
      }
      throw new ReconcileAbort(
        failure("cleanup_pending", `Deleting device '${oldId}' failed: ${deletion.message}`),
      );
    }
    evidence.deletedStableId = oldId;
    // Record the verified absence before creating: a later failure or crash leaves an empty slot
    // whose next attempt creates, and the old incarnation can never be deleted again.
    const emptied = await registry.commitBinding(request.key, expectationOf(marked.assignment), {
      stableDeviceId: null,
      deviceName: null,
      requestedSpec: request.requestedSpec,
      resolvedSpec: null,
      specFingerprint: null,
      state: "provisioning",
    });
    if (emptied.kind !== "committed") {
      throw new ReconcileAbort(casFailure(emptied, "replace"));
    }
    return await this.createAndCommit(context, emptied.assignment, "replaced");
  }

  /**
   * Every precondition for destroying the slot's device: complete discovery, no live claim, boot
   * capacity for the replacement, and the registry still naming this exact binding as its holder.
   */
  private async assertReplaceable(
    request: ManagedSlotReconcileRequest,
    assignment: SlotAssignmentRecord,
    device: DeviceInfo,
    inventoryComplete: boolean,
  ): Promise<void> {
    const oldId = assignment.stableDeviceId!;
    if (!inventoryComplete) {
      throw new ReconcileAbort(
        failure("discovery_incomplete", "Replacement requires complete device discovery."),
      );
    }
    const claim = await this.deps.claims.describe(device);
    if (claim.kind !== "free") {
      throw new ReconcileAbort(
        failure(
          claim.kind === "held" ? "device_busy" : "discovery_incomplete",
          `Device '${oldId}' cannot be replaced: ${claim.reason}`,
        ),
      );
    }
    // Deleting a running device frees a boot slot; a stopped one does not, so fail before deleting.
    if (!device.isRunning) {
      await this.assertBootCapacity(request, undefined);
    }
    this.checkBudget(request);
    const holder = await this.deps.registry.findDeviceHolder(request.platform, oldId);
    if (
      holder?.kind !== "slot" ||
      holder.assignment.scopeKey !== request.key.scopeKey ||
      holder.assignment.slotIndex !== request.key.slotIndex ||
      !bindingMatches(holder.assignment, expectationOf(assignment))
    ) {
      throw new ReconcileAbort(
        failure("concurrent_modification", `Device '${oldId}' is no longer this slot's device.`),
      );
    }
  }

  // --- shared steps ----------------------------------------------------------------------------

  private async provisionExisting(
    context: ReconcileContext,
    device: DeviceInfo,
  ): Promise<ManagedSlotProvisionedDevice> {
    const { request } = context;
    let provisioned: ManagedSlotProvisionedDevice;
    try {
      provisioned = await this.deps.provisioner.provision({
        platform: request.platform,
        name: device.name,
        ...(request.platform === "ios" && device.deviceId ? { deviceId: device.deviceId } : {}),
        spec: request.requestedSpec,
        mode: "adopt",
        deadlineMs: request.deadlineMs,
        signal: request.signal,
      });
    } catch (error) {
      throw new ReconcileAbort(provisionFailure(error));
    }
    if (!this.isAutomationReady(provisioned)) {
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(
        failure(
          "readiness_incomplete",
          `Device '${device.name}' did not reach automation readiness.`,
        ),
      );
    }
    return provisioned;
  }

  private isAutomationReady(provisioned: ManagedSlotProvisionedDevice): boolean {
    return (
      provisioned.sessionUuid.length > 0 &&
      provisioned.readiness.mode === "automation" &&
      provisioned.readiness.status === "automation_ready"
    );
  }

  /** Fail immediately at the boot limit when the device would need a boot. */
  private async assertBootCapacity(
    request: ManagedSlotReconcileRequest,
    device: DeviceInfo | undefined,
  ): Promise<void> {
    if (!this.deps.capacity || device?.isRunning) {
      return;
    }
    const check = await this.deps.capacity.check(request.platform, { signal: request.signal });
    if (check.kind === "exhausted") {
      throw new ReconcileAbort(
        failure(
          "capacity_exhausted",
          `${check.booted} ${request.platform} device(s) booted; limit is ${check.limit}.`,
          {
            capacity: {
              limit: check.limit,
              booted: check.booted,
              retryAfterMs: check.retryAfterMs,
            },
          },
        ),
      );
    }
  }

  private async deleteDevice(
    target: ManagedSlotDeletionTarget,
  ): Promise<ManagedSlotDeletionResult> {
    try {
      return await this.deps.deleter.deleteAndVerifyAbsence(target);
    } catch (error) {
      // An unverified deletion is a failed deletion: the device may still exist.
      logger.warn(
        `[ManagedSlots] deleting '${target.stableId}' threw: ${errorMessage(error)}`,
        error,
      );
      return { kind: "failed", message: errorMessage(error) };
    }
  }

  private async releaseSession(sessionUuid: string): Promise<void> {
    try {
      await this.deps.provisioner.releaseSession(sessionUuid);
    } catch (error) {
      logger.warn(
        `[ManagedSlots] releasing unpublished session ${sessionUuid} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private checkBudget(request: ManagedSlotReconcileRequest): void {
    if (request.signal?.aborted) {
      throw new ReconcileAbort(failure("cancelled", "Slot preparation was cancelled."));
    }
    if (this.deps.timer.now() >= request.deadlineMs) {
      throw new ReconcileAbort(failure("timeout", "Slot preparation deadline passed."));
    }
  }

  /**
   * Hand the slot to the request's execution (superseding its own reservation) under the binding
   * just committed, then report ready. A lost claim releases the session it would have published.
   */
  private async claimAndReady(
    context: ReconcileContext,
    disposition: ManagedSlotDisposition,
    assignment: SlotAssignmentRecord,
    provisioned: ManagedSlotProvisionedDevice,
    reservation: string | undefined,
  ): Promise<ReadyResult> {
    const { owner, key } = context.request;
    if (!owner) {
      return this.ready(context, disposition, assignment, provisioned);
    }
    const claimed = await this.deps.registry.claimExecution(
      key,
      expectationOf(assignment),
      { ...owner, sessionUuid: provisioned.sessionUuid },
      reservation ? { supersedesSessionUuid: reservation } : {},
    );
    if (claimed.kind !== "claimed") {
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(claimFailure(claimed, "execution claim"));
    }
    return this.ready(context, disposition, claimed.assignment, provisioned);
  }

  private ready(
    context: ReconcileContext,
    disposition: ManagedSlotDisposition,
    assignment: SlotAssignmentRecord,
    provisioned: ManagedSlotProvisionedDevice,
  ): ReadyResult {
    return {
      outcome: "ready",
      disposition,
      assignment,
      device: provisioned.device,
      sessionUuid: provisioned.sessionUuid,
      requestedSpec: context.request.requestedSpec,
      resolvedSpec: context.resolvedSpec,
      specFingerprint: context.fingerprint,
      readiness: provisioned.readiness,
      ...(provisioned.lifecycle !== undefined ? { lifecycle: provisioned.lifecycle } : {}),
      evidence: context.evidence,
    };
  }
}
