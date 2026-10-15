import { BROKER_DEVICE_NAME_PREFIX, isProductBrokerDevice } from "../persistedIdentity";
import { BindingJournalRemovalRegistryTimeout } from "../registry/bindingJournal";
import { createHash } from "node:crypto";
import { classifySqliteError } from "../../../db/databaseFailureClassification";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import {
  evaluateIosPairCompatibility,
  iosDeviceSpecificationMismatch,
  matchesAndroidDeviceSpecification,
  resolveDisplayCutoutPreference,
} from "../../../devices/deviceSpecMatching";
import {
  ProvisionDeviceError,
  type AndroidDeviceSpecification,
  type ExactDeviceSpecification,
  type ExactIosRuntimeCatalog,
  type IosDeviceSpecification,
  type ResolvedExactDeviceSpecification,
} from "../../../devices/exactDeviceProvisioning";
import type { BindingResourceBudget, BindingResourceAdmission } from "./resourceBudget";
import type { DeviceInfo } from "../../../models/index";
import type { BindingBudgetEvidence } from "./acquisitionResult";
import type { FormFactor } from "../../../models/DeviceMatchCriteria";
import { androidProfileFormFactor } from "../../../models/formFactor";
import type { BindingDeviceFamily } from "../../../server/provisionDeviceSpecSchemas";
import { inferIosFormFactor } from "../../../utils/ios-cmdline-tools/iosDeviceType";
import { evaluateRuntimeCompatibility } from "../../../utils/ios-cmdline-tools/runtimeCompatibility";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { OCCUPYING_SIMULATOR_STATES } from "../../../features/iosSimFleet/FleetCostCollector";
import { BootCapacityExhaustedError } from "../../../models/BootCapacityExhaustedError";
import type { AvdConfigReader } from "../../../utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { errorMessage } from "../../../utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import {
  defaultBindingExecOwnerLiveness,
  type InFlightBindingReservations,
  inFlightBindingReservations,
} from "../registry/ownerLiveness";
import type { BackoffInput } from "../../../utils/Backoff";
import { currentDaemonProcessGenerationToken } from "../../processGeneration";
import { deviceStableId } from "../registry/deviceIdentity";
import {
  BindingJournal,
  type BindingJournalInFlight,
  type BindingJournalOwnerLiveness,
  type BindingJournalRedriveRecord,
} from "../registry/bindingJournal";
import { logger } from "../../../utils/logger";
import { stableStringify } from "../../../utils/stableStringify";
import type { Timer } from "../../../utils/SystemTimer";
import {
  bindingMatches,
  type BindingAssignmentRecord,
  type BindingBindingExpectation,
  type BindingCasFailure,
  type BindingExecOwner,
  type BindingExecOwnerLiveness,
  type BindingJournalEntry,
  type BindingJournalOwner,
  type BindingKey,
  type BindingPlatform,
  type BindingRegistry,
} from "../registry/bindingRegistry";

/**
 * Declarative spec reconciler for one managed device binding (#11175, epic #11172).
 *
 * Given a scoped binding, a requested spec, the host-wide binding registry and the device inventory, it
 * decides between four dispositions and carries the decision out:
 *
 * - `reused`: the binding's assigned device satisfies the spec; it gets a fresh session.
 * - `adopted`: an empty binding takes a matching device that no valid binding holds (the free pool of
 *   invalidated scopes, or this binding's own uncommitted leftover from an interrupted create).
 * - `created`: no eligible device; a new one is provisioned under a generated name.
 * - `replaced`: the assigned device does not satisfy the spec; it is deleted, its absence is
 *   verified, a new one is created, and the result is committed into the same binding.
 *
 * Safety rules:
 * - Omitted spec fields are unconstrained (owner decision Q4); the resolved spec is recorded.
 * - Only this binding's own assigned device is ever deleted, and only after the spec is resolved,
 *   discovery is complete, no live owner or claim holds it and the binding binding still holds.
 * - Partial inventory or an unreadable device configuration is never authoritative absence or
 *   mismatch; it fails retryable `discovery_incomplete` without destructive work.
 * - Every registry mutation compare-and-sets `(generation, stableDeviceId)`, so a lost race never
 *   overwrites a newer binding. A deletion that fails leaves the old binding as `cleanup_pending`;
 *   a replacement creation that fails after verified deletion leaves the binding empty (`provisioning`).
 *   A failed fresh creation removes its never-bound row only after journal rollback proves absence;
 *   an open journal retains the row for redrive.
 * - Boot capacity fails immediately with retryable `capacity_exhausted` (owner decision): the
 *   reconciler never waits for capacity, never creates a device it could not boot, and checks
 *   before it deletes the device a replacement would not be able to boot.
 * - Every create and replace is journaled (`slot_journal`, #11179) with its exact devices, and each
 *   acquisition first redrives the binding's unfinished work of a dead owner (see `bindingJournal.ts`),
 *   so a retry after an interruption converges instead of repeating destructive work.
 *
 * Not yet wired into the acquire RPC (step 5 of the epic); callers inject the ports below.
 */

export const BINDING_SPEC_FINGERPRINT_VERSION = 1;
/** Generated device names start with this; a prefix alone is never deletion authority. */

export interface BindingSpecFingerprint {
  version: typeof BINDING_SPEC_FINGERPRINT_VERSION;
  hash: string;
}

export type BindingDisposition = "reused" | "adopted" | "created" | "replaced";

type WithOptionalDeviceType<T extends { deviceType: string }> = Omit<T, "deviceType"> & {
  deviceType?: string;
  deviceFamily?: BindingDeviceFamily;
};

/**
 * A binding's requested spec: an exact spec whose `deviceType` (the model or hardware
 * profile) may be omitted. Omitted means "any model" (owner decision Q4), constrained only by an
 * optional `deviceFamily`: matching retains the requested constraints, and a device that must be
 * created gets a compatible model the resolver picks and records in the resolved spec.
 */
export type BindingRequestedSpec =
  | WithOptionalDeviceType<AndroidDeviceSpecification>
  | WithOptionalDeviceType<IosDeviceSpecification>;

/** Known device metadata; an Android AVD may have no configured hardware profile. */
export interface BindingResolvedSpec {
  runtime: string;
  deviceType?: string;
  displayCutout?: ResolvedExactDeviceSpecification["displayCutout"];
  configuration?: AndroidDeviceSpecification["configuration"];
}

/**
 * The Android hardware profile created for a spec that omits `deviceType` (a current Pixel with a
 * known cutout class). Override per resolver.
 */
export const BINDING_DEFAULT_ANDROID_DEVICE_TYPE = "pixel_8";

export const BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY = {
  phone: BINDING_DEFAULT_ANDROID_DEVICE_TYPE,
  tablet: "pixel_tablet",
  foldable: "pixel_fold",
} as const satisfies Record<BindingDeviceFamily, string>;

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
  list(
    platform: BindingPlatform,
    options: { signal?: AbortSignal },
  ): Promise<BindingInventorySnapshot>;
}

/** `unknown` means the device's configuration could not be read; it never justifies deletion. */
export type ManagedSpecMatch = "match" | "mismatch" | "unknown";

export interface ManagedSpecMatcher {
  matches(device: DeviceInfo, spec: BindingRequestedSpec): Promise<ManagedSpecMatch>;
}

export type ManagedSpecResolution =
  | {
      kind: "resolved";
      resolvedSpec: ResolvedExactDeviceSpecification;
      fingerprint: BindingSpecFingerprint;
    }
  | { kind: "unsupported"; code: "spec_unsupported" | "runtime_incompatible"; message: string }
  /** The spec could not be resolved yet (an unreadable catalog); retryable, nothing changed. */
  | { kind: "unresolved"; message: string };

export type ManagedSpecCreatability =
  | { kind: "creatable" }
  | { kind: "unsupported"; code: "spec_unsupported" | "runtime_incompatible"; message: string }
  | { kind: "unresolved"; message: string };

/** Validates and resolves a spec before any destructive work. */
export interface ManagedSpecResolver {
  resolve(
    platform: BindingPlatform,
    spec: BindingRequestedSpec,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecResolution>;
  /** Checks creation-only prerequisites without blocking reuse or adoption. */
  checkCreatable?(
    platform: BindingPlatform,
    resolvedSpec: ResolvedExactDeviceSpecification,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecCreatability>;
}

export interface BindingProvisionRequest {
  platform: BindingPlatform;
  /** Android: the AVD name (stable id). iOS: the simulator name. */
  name: string;
  /** iOS UDID of an existing simulator to adopt. */
  deviceId?: string;
  /**
   * `create` always carries a concrete `deviceType` (the resolved model). `adopt` carries the
   * requested spec, whose omitted `deviceType` accepts the existing device's model.
   * Neither mode carries `deviceFamily`: the reconciler applies that request constraint before
   * provisioning, and the provisionDevice schema accepts configuration fields only.
   */
  spec: BindingRequestedSpec;
  /** `adopt` must never create; `create` provisions a new device under `name`. */
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
    }
  /** The booted count could not be established; never read as free capacity. */
  | { kind: "unknown"; message: string };

/** Immediate boot capacity probe (no waiting). Absent means boots are not gated. */
export interface BindingBootCapacity {
  check(
    platform: BindingPlatform,
    options: { signal?: AbortSignal },
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
  /** Non-authoritative: preferred among adoption candidates, never trusted for deletion. */
  priorDeviceHint?: { stableId: string };
  /** Absolute deadline on the timer's clock for the whole preparation. */
  deadlineMs: number;
  signal?: AbortSignal;
  /**
   * The execution the prepared device is for. When set, the reconciler claims the binding for it
   * atomically with the outcome: an assigned device is reserved BEFORE it is provisioned (so no
   * concurrent replacement can mark it while a session is being bound), and the ready result
   * names this owner with the provisioned session. Without it the caller claims afterwards.
   */
  owner?: Omit<BindingExecOwner, "sessionUuid">;
}

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
  | "capacity_exhausted"
  | "binding_budget_exhausted"
  | "concurrent_modification"
  | "readiness_incomplete"
  | "stale_session"
  | "provision_failed"
  | "timeout"
  | "cancelled";

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

/** Every code the reconciler can fail with; the `Record` key keeps it complete. */
export const BINDING_RECONCILE_FAILURE_CODES = Object.keys(
  FAILURE_RETRYABILITY,
) as BindingReconcileFailureCode[];

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

export interface BindingReconcileFailure {
  code: BindingReconcileFailureCode;
  retryable: boolean;
  message: string;
  nextAction: string;
  /** Underlying provision failure, when the provision path refused. */
  provision?: { code: string; retryable: boolean };
  capacity?: BindingFailureCapacity;
  budget?: BindingBudgetEvidence;
}

/** Same `externalDevices` name and shape as the non-binding `capacity_exhausted` refusal (#11390). */
export interface BindingFailureCapacity {
  limit: number;
  booted: number;
  retryAfterMs: number;
  externalDevices?: string[];
}

export interface BindingReconcileEvidence {
  /** Assignment as read before any mutation (null when the scope was not valid). */
  initial: { generation: number; stableDeviceId: string | null; state: string } | null;
  inventoryComplete: boolean | null;
  /** Match verdict for the assigned device, when one was present. */
  assignedMatch?: ManagedSpecMatch;
  assignedMissing?: boolean;
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

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

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

function bindingDeviceNameSuffix(key: BindingKey): string {
  return `${key.scopeKey.slice(0, 8)}-${key.bindingIndex}-g`;
}

export function computeManagedSpecFingerprint(
  platform: BindingPlatform,
  resolvedSpec: ResolvedExactDeviceSpecification,
): BindingSpecFingerprint {
  const hash = createHash("sha256")
    .update(stableStringify({ version: BINDING_SPEC_FINGERPRINT_VERSION, platform, resolvedSpec }))
    .digest("hex");
  return { version: BINDING_SPEC_FINGERPRINT_VERSION, hash };
}

/** The registry column form of a fingerprint: `v<version>:<hash>`. */
export function encodeManagedSpecFingerprint(fingerprint: BindingSpecFingerprint): string {
  return `v${fingerprint.version}:${fingerprint.hash}`;
}

export { deviceStableId };

/** Matches with the shared exact-provisioning matchers (#11100) — one definition of "matches". */
export class DefaultManagedSpecMatcher implements ManagedSpecMatcher {
  constructor(private readonly androidConfigReader: Pick<AvdConfigReader, "readConfig">) {}

  async matches(device: DeviceInfo, spec: BindingRequestedSpec): Promise<ManagedSpecMatch> {
    if (device.platform === "android") {
      let config: Awaited<ReturnType<AvdConfigReader["readConfig"]>>;
      try {
        config = await this.androidConfigReader.readConfig(device.name);
      } catch (error) {
        logger.warn(
          `[Bindings] cannot read AVD config for '${device.name}': ${errorMessage(error)}`,
          error,
        );
        return "unknown";
      }
      if (!config) {
        return "unknown";
      }
      // An omitted hardware profile is unconstrained: the AVD's own profile (even an unset one)
      // satisfies it.
      const constraints = {
        ...(spec as WithOptionalDeviceType<AndroidDeviceSpecification>),
        deviceType: (spec.deviceType ?? config.deviceName) as string,
      };
      if (!matchesAndroidDeviceSpecification(constraints, config)) {
        return "mismatch";
      }
      return matchDeviceFamily(spec.deviceFamily, () =>
        androidProfileFormFactor({
          profileId: config.deviceName,
          width: config.screenWidth,
          height: config.screenHeight,
          density: config.screenDensity,
        }),
      );
    }
    // An unavailable simulator (runtime unmounted, or listed under a different Xcode or
    // DEVELOPER_DIR) proves nothing about its configuration, so it is never a mismatch to replace.
    if (
      device.isAvailable === false ||
      device.runtime === undefined ||
      (spec.deviceType !== undefined && device.deviceType === undefined)
    ) {
      return "unknown";
    }
    // An omitted model is unconstrained: the simulator's own model satisfies it.
    const constraints = {
      runtime: spec.runtime,
      deviceType: spec.deviceType ?? device.deviceType!,
    };
    return iosDeviceSpecificationMismatch(constraints, device) === undefined
      ? matchDeviceFamily(spec.deviceFamily, () => inferIosFormFactor(device.deviceType))
      : "mismatch";
  }
}

function matchDeviceFamily(
  requested: BindingDeviceFamily | undefined,
  infer: () => FormFactor | undefined,
): ManagedSpecMatch {
  if (requested === undefined) {
    return "match";
  }
  const actual = infer();
  if (actual === undefined || actual === "unknown") {
    return "unknown";
  }
  return actual === requested ? "match" : "mismatch";
}

/** Request-only constraints must not enter provisionDevice or configuration fingerprints. */
function provisionableSpec(spec: BindingRequestedSpec): BindingRequestedSpec {
  const configuration = { ...spec };
  delete configuration.deviceFamily;
  return configuration;
}

function unsupportedModelFamily(
  platform: BindingPlatform,
  spec: BindingRequestedSpec,
): string | undefined {
  if (spec.deviceType === undefined || spec.deviceFamily === undefined) {
    return undefined;
  }
  const actual =
    platform === "ios"
      ? inferIosFormFactor(spec.deviceType)
      : androidProfileFormFactor({ profileId: spec.deviceType });
  if (actual === undefined || actual === "unknown") {
    return `The family of deviceType '${spec.deviceType}' cannot be verified before creation for deviceFamily '${spec.deviceFamily}'. Request either deviceType or deviceFamily, not both.`;
  }
  return actual === spec.deviceFamily
    ? undefined
    : `deviceType '${spec.deviceType}' is a ${actual}; it conflicts with deviceFamily '${spec.deviceFamily}'.`;
}

function unsupportedFamilyScreenOverrides(
  platform: BindingPlatform,
  spec: BindingRequestedSpec,
): string | undefined {
  if (platform !== "android" || spec.deviceFamily === undefined || !("configuration" in spec)) {
    return undefined;
  }
  const overridden = (["screenWidth", "screenHeight", "screenDensity"] as const).some(
    (field) => spec.configuration?.[field] !== undefined,
  );
  return overridden
    ? "The family is classified from screen geometry, so it cannot be verified before creation when the geometry is overridden. Request deviceFamily without screen overrides, or an explicit deviceType without deviceFamily."
    : undefined;
}

const IOS_RUNTIME_IDENTIFIER_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

/** The Android system-image packages installed in the SDK, as `system-images;...` identifiers. */
export interface ManagedAndroidImageCatalog {
  listInstalledPackages(signal?: AbortSignal): Promise<string[]>;
}

export interface ManagedAndroidProfileCatalog {
  listProfileIds(signal?: AbortSignal): Promise<string[]>;
}

export interface DefaultManagedSpecResolverOptions {
  /** Profile created for an Android spec that omits `deviceType`. */
  androidDefaultDeviceType?: string;
  androidDefaultDeviceTypesByFamily?: Partial<Record<BindingDeviceFamily, string>>;
  /**
   * With a catalog, an Android spec whose system image is not installed is refused as
   * `spec_unsupported` before anything is created, instead of surfacing avdmanager's raw text.
   */
  androidImageCatalog?: ManagedAndroidImageCatalog;
  androidProfileCatalog?: ManagedAndroidProfileCatalog;
}

/**
 * Resolves a spec with the shared exact-provisioning checks. Codes are aligned across platforms:
 * `spec_unsupported` for a malformed spec (an Android runtime that is not a system-image id, an iOS
 * runtime that is not a CoreSimulator id) or one naming what this host has not installed (an
 * Android image, an iOS runtime or device type, with a catalog); `runtime_incompatible` only for an
 * installed iOS model/runtime pair the catalog proves incompatible. Unreadable catalogs are
 * unknown, not unsupported, matching the provisioner.
 *
 * An omitted `deviceType` ("any model") resolves to the model a creation would use: on iOS the
 * newest iPhone the catalog lists as supporting the runtime (so a catalog is required), on Android
 * {@link BINDING_DEFAULT_ANDROID_DEVICE_TYPE} unless overridden. Matching still accepts any
 * model within an optional requested family; only creation uses the resolved one. Android family
 * defaults can be overridden individually. A cutout preference needs an explicit model.
 */
export class DefaultManagedSpecResolver implements ManagedSpecResolver {
  private readonly androidDefaultDeviceType: string;
  private readonly androidDefaultDeviceTypesByFamily: Record<BindingDeviceFamily, string>;
  private readonly androidImageCatalog?: ManagedAndroidImageCatalog;
  private readonly androidProfileCatalog?: ManagedAndroidProfileCatalog;

  constructor(
    private readonly iosRuntimeCatalog?: ExactIosRuntimeCatalog,
    options: DefaultManagedSpecResolverOptions = {},
  ) {
    this.androidDefaultDeviceType =
      options.androidDefaultDeviceType ?? BINDING_DEFAULT_ANDROID_DEVICE_TYPE;
    this.androidDefaultDeviceTypesByFamily = {
      ...BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY,
      phone: this.androidDefaultDeviceType,
      ...options.androidDefaultDeviceTypesByFamily,
    };
    this.androidImageCatalog = options.androidImageCatalog;
    this.androidProfileCatalog = options.androidProfileCatalog;
  }

  async checkCreatable(
    platform: BindingPlatform,
    resolvedSpec: ResolvedExactDeviceSpecification,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecCreatability> {
    if (platform !== "android" || !this.androidProfileCatalog) {
      return { kind: "creatable" };
    }
    let profileIds: string[];
    try {
      profileIds = await this.androidProfileCatalog.listProfileIds(options.signal);
    } catch (error) {
      logger.warn(`[Bindings] Android profile catalog unreadable: ${errorMessage(error)}`, error);
      return {
        kind: "unresolved",
        message: `The Android hardware profile catalog could not be read: ${errorMessage(error)}`,
      };
    }
    if (profileIds.includes(resolvedSpec.deviceType)) {
      return { kind: "creatable" };
    }
    return {
      kind: "unsupported",
      code: "spec_unsupported",
      message: `Android hardware profile '${resolvedSpec.deviceType}' is not available on this host. List valid profile IDs with avdmanager list device.`,
    };
  }

  async resolve(
    platform: BindingPlatform,
    spec: BindingRequestedSpec,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecResolution> {
    const unsupported = await this.findUnsupportedSpec(platform, spec, options.signal);
    if (unsupported) {
      return { kind: "unsupported", code: "spec_unsupported", message: unsupported };
    }
    const model = await this.resolveDeviceType(platform, spec, options.signal);
    if (model.kind !== "resolved") {
      return model.resolution;
    }
    const exact = {
      ...provisionableSpec(spec),
      deviceType: model.deviceType,
    } as ExactDeviceSpecification;
    const cutout = resolveDisplayCutoutPreference(platform, exact);
    if (cutout.kind !== "resolved") {
      return { kind: "unsupported", code: "spec_unsupported", message: cutout.message };
    }
    if (platform === "ios" && this.iosRuntimeCatalog && spec.deviceType !== undefined) {
      const incompatible = await this.findIosIncompatibility(exact, options.signal);
      if (incompatible) {
        return { kind: "unsupported", code: "runtime_incompatible", message: incompatible };
      }
    }
    const resolvedSpec = {
      ...exact,
      displayCutout: cutout.displayCutout,
    } as ResolvedExactDeviceSpecification;
    return {
      kind: "resolved",
      resolvedSpec,
      fingerprint: computeManagedSpecFingerprint(platform, resolvedSpec),
    };
  }

  /**
   * Why the spec is `spec_unsupported` before any model is chosen: malformed (an Android runtime
   * that is not a system-image id, an iOS runtime that is not a CoreSimulator id), or naming what
   * the host has not installed. Undefined when it may proceed.
   */
  private async findUnsupportedSpec(
    platform: BindingPlatform,
    spec: BindingRequestedSpec,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const familyConflict =
      unsupportedFamilyScreenOverrides(platform, spec) ?? unsupportedModelFamily(platform, spec);
    if (familyConflict !== undefined) {
      return familyConflict;
    }
    if (platform === "android") {
      return parseAndroidSystemImageRuntime(spec.runtime)
        ? await this.findMissingAndroidImage(spec.runtime, signal)
        : `Android runtime '${spec.runtime}' is not a system-image identifier.`;
    }
    return spec.runtime.startsWith(IOS_RUNTIME_IDENTIFIER_PREFIX)
      ? await this.findMissingIosCatalogEntry(spec, signal)
      : `iOS runtime '${spec.runtime}' is not a CoreSimulator runtime identifier (${IOS_RUNTIME_IDENTIFIER_PREFIX}...).`;
  }

  private async resolveDeviceType(
    platform: BindingPlatform,
    spec: BindingRequestedSpec,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: "resolved"; deviceType: string }
    | { kind: "refused"; resolution: ManagedSpecResolution }
  > {
    if (spec.deviceType !== undefined) {
      return { kind: "resolved", deviceType: spec.deviceType };
    }
    if (spec.displayCutout !== undefined && spec.displayCutout !== "any") {
      return refused(
        "spec_unsupported",
        `A display cutout preference ('${spec.displayCutout}') needs an explicit deviceType.`,
      );
    }
    if (platform === "android") {
      return {
        kind: "resolved",
        deviceType:
          spec.deviceFamily === undefined
            ? this.androidDefaultDeviceType
            : this.androidDefaultDeviceTypesByFamily[spec.deviceFamily],
      };
    }
    if (!this.iosRuntimeCatalog) {
      return refused(
        "spec_unsupported",
        "An iOS spec without deviceType needs the simulator catalog to choose a model.",
      );
    }
    let runtimes: AppleDeviceRuntime[];
    let deviceTypes: AppleDeviceType[];
    try {
      [runtimes, deviceTypes] = await Promise.all([
        this.iosRuntimeCatalog.getRuntimesChecked(undefined, signal),
        this.iosRuntimeCatalog.getDeviceTypesChecked(signal),
      ]);
    } catch (error) {
      logger.warn(
        `[Bindings] iOS catalog unreadable; cannot choose a model: ${errorMessage(error)}`,
        error,
      );
      return {
        kind: "refused",
        resolution: {
          kind: "unresolved",
          message: `The simulator catalog could not be read to choose a model: ${errorMessage(error)}`,
        },
      };
    }
    const deviceType = chooseIosDeviceType(spec.runtime, runtimes, deviceTypes, spec.deviceFamily);
    return deviceType
      ? { kind: "resolved", deviceType }
      : refused(
          "runtime_incompatible",
          `No installed ${spec.deviceFamily ?? "iPhone"} model supports runtime '${spec.runtime}', or the runtime is not available.`,
        );
  }

  private async findMissingAndroidImage(
    runtime: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (!this.androidImageCatalog) {
      return undefined;
    }
    let installed: string[];
    try {
      installed = await this.androidImageCatalog.listInstalledPackages(signal);
    } catch (error) {
      // An unreadable SDK listing is not proof the image is missing; avdmanager stays the authority.
      logger.warn(`[Bindings] Android image check skipped: ${errorMessage(error)}`, error);
      return undefined;
    }
    if (installed.includes(runtime)) {
      return undefined;
    }
    return `Android system image '${runtime}' is not installed. Install it with sdkmanager, or request an installed image (${installed.join(", ") || "none installed"}).`;
  }

  /**
   * The refusal for an iOS runtime or device type the simulator catalog does not list (#11271),
   * checked before anything is created instead of surfacing simctl's raw "Invalid device type" text
   * or reporting a missing runtime as a model/runtime mismatch. Not installed is spec_unsupported,
   * as for Android's uninstalled image (#11269); `runtime_incompatible` stays for an installed
   * runtime that is unavailable or outside the model's range. No catalog, or an unreadable one, is
   * not proof; simctl stays the authority.
   */
  private async findMissingIosCatalogEntry(
    spec: BindingRequestedSpec,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (!this.iosRuntimeCatalog) {
      return undefined;
    }
    let runtimes: AppleDeviceRuntime[];
    let deviceTypes: AppleDeviceType[];
    try {
      [runtimes, deviceTypes] = await Promise.all([
        this.iosRuntimeCatalog.getRuntimesChecked(undefined, signal),
        this.iosRuntimeCatalog.getDeviceTypesChecked(signal),
      ]);
    } catch (error) {
      logger.warn(`[Bindings] iOS catalog check skipped: ${errorMessage(error)}`, error);
      return undefined;
    }
    if (!runtimes.some((entry) => entry.identifier === spec.runtime)) {
      const installed = runtimes.map((entry) => entry.identifier);
      return (
        `iOS runtime '${spec.runtime}' is not installed on this host. Install it with Xcode, or ` +
        `request an installed runtime (${installed.join(", ") || "none installed"}).`
      );
    }
    if (
      spec.deviceType === undefined ||
      deviceTypes.some((entry) => entry.identifier === spec.deviceType)
    ) {
      return undefined;
    }
    const iphones = deviceTypes
      .filter((entry) => entry.productFamily === "iPhone")
      .map((entry) => entry.identifier);
    return (
      `iOS device type '${spec.deviceType}' is not installed on this host. Request an installed ` +
      `device type (iPhone types: ${iphones.join(", ") || "none installed"}; all types: ` +
      "xcrun simctl list devicetypes)."
    );
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
      logger.warn(`[Bindings] iOS catalog check skipped: ${errorMessage(error)}`, error);
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

function refused(
  code: "spec_unsupported" | "runtime_incompatible",
  message: string,
): { kind: "refused"; resolution: ManagedSpecResolution } {
  return { kind: "refused", resolution: { kind: "unsupported", code, message } };
}

/**
 * The model "any model" creates for an iOS runtime: a supported iPhone (excluding iPods),
 * else one with unknown runtime compatibility (simctl stays the authority). An explicit family
 * selects that family's types instead. Within each tier, parseable iPhone/iPad model identifiers
 * outrank unparseable ones: highest major generation, then lowest minor variant, then shortest
 * name, then ascending identifier wins. Unparseable entries retain last-in-catalog selection.
 * Undefined when the runtime is missing or unavailable, or no selected-family type fits.
 */
export function chooseIosDeviceType(
  runtimeId: string,
  runtimes: readonly AppleDeviceRuntime[],
  deviceTypes: readonly AppleDeviceType[],
  family?: BindingDeviceFamily,
): string | undefined {
  const runtime = runtimes.find((entry) => entry.identifier === runtimeId);
  if (!runtime?.isAvailable) {
    return undefined;
  }
  const candidates = deviceTypes.filter((entry) =>
    family === undefined
      ? entry.productFamily === "iPhone" && !entry.modelIdentifier?.startsWith("iPod")
      : inferIosFormFactor(entry.identifier) === family,
  );
  const statusOf = (entry: AppleDeviceType) =>
    evaluateRuntimeCompatibility(entry, runtime.version).status;
  const supported = candidates.filter((entry) => statusOf(entry) === "supported");
  const unknown = candidates.filter((entry) => statusOf(entry) === "unknown");
  return (
    supported.toSorted(compareNewestDeviceType).at(-1) ??
    unknown.toSorted(compareNewestDeviceType).at(-1)
  )?.identifier;
}

/** Positive means preferred; stable sorting retains catalog order for unparseable models. */
function compareNewestDeviceType(a: AppleDeviceType, b: AppleDeviceType): number {
  const aModel = /^(iPhone|iPad)(\d+),(\d+)$/.exec(a.modelIdentifier ?? "");
  const bModel = /^(iPhone|iPad)(\d+),(\d+)$/.exec(b.modelIdentifier ?? "");
  if (!aModel || !bModel) {
    return Number(Boolean(aModel)) - Number(Boolean(bModel));
  }
  return (
    Number(aModel[2]) - Number(bModel[2]) ||
    Number(bModel[3]) - Number(aModel[3]) ||
    b.name.length - a.name.length ||
    (a.identifier < b.identifier ? 1 : a.identifier > b.identifier ? -1 : 0)
  );
}

class ReconcileAbort extends Error {
  constructor(readonly failure: BindingReconcileFailure) {
    super(failure.message);
    this.name = "ReconcileAbort";
  }
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

function casFailure(result: BindingCasFailure, step: string): BindingReconcileFailure {
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
function claimFailure(
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

function externalDevicesField(devices: readonly string[] | undefined): {
  externalDevices?: string[];
} {
  return devices && devices.length > 0 ? { externalDevices: [...devices] } : {};
}

/** Map a provision-path error into a typed reconcile failure. */
function provisionFailure(error: unknown): BindingReconcileFailure {
  if (error instanceof BootCapacityExhaustedError) {
    return failure("capacity_exhausted", error.message, {
      capacity: {
        limit: error.limit,
        booted: error.booted,
        retryAfterMs: error.retryAfterMs,
        ...externalDevicesField(error.details.externalDevices),
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

/**
 * Whether the device counts toward its platform's boot limit, by the gates' own definition: a
 * simulator that is booting or shutting down holds its binding although it is not listed as running.
 */
function holdsBootBinding(device: DeviceInfo): boolean {
  return (
    device.isRunning ||
    (device.platform === "ios" &&
      device.state !== undefined &&
      OCCUPYING_SIMULATOR_STATES.has(device.state))
  );
}

function bindingId(key: BindingKey): string {
  return `${key.scopeKey}#${key.bindingIndex}`;
}

function expectationOf(assignment: BindingAssignmentRecord): BindingBindingExpectation {
  return { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId };
}

interface ReconcileContext {
  request: BindingReconcileRequest;
  resolvedSpec: BindingResolvedSpec;
  fingerprint: BindingSpecFingerprint;
  evidence: BindingReconcileEvidence;
  creatabilityChecked?: boolean;
}

type ReadyResult = Extract<BindingReconcileResult, { outcome: "ready" }>;

// ---------------------------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------------------------

export class BindingReconciler {
  /** Serializes reconciliations of one binding inside this process. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly isExecOwnerLive: BindingExecOwnerLiveness;
  private readonly idGenerator: IdGenerator;
  private readonly reservations: Pick<InFlightBindingReservations, "add" | "delete">;

  readonly journal: BindingJournal;

  constructor(private readonly deps: BindingReconcilerDependencies) {
    this.isExecOwnerLive = deps.isExecOwnerLive ?? defaultBindingExecOwnerLiveness;
    this.idGenerator = deps.idGenerator ?? defaultIdGenerator;
    this.reservations = deps.reservations ?? inFlightBindingReservations;
    this.journal = new BindingJournal({
      registry: deps.registry,
      inventory: deps.inventory,
      matcher: deps.matcher,
      deleter: deps.deleter,
      claims: deps.claims,
      isBusy: deps.isBusy,
      timer: deps.timer,
      owner: deps.journal?.owner ?? processJournalOwner(),
      isExecOwnerLive: this.isExecOwnerLive,
      ...(deps.journal?.isOwnerLive ? { isOwnerLive: deps.journal.isOwnerLive } : {}),
      ...(deps.journal?.inFlight ? { inFlight: deps.journal.inFlight } : {}),
      ...(deps.journal?.backoff !== undefined ? { backoff: deps.journal.backoff } : {}),
    });
  }

  async reconcile(request: BindingReconcileRequest): Promise<BindingReconcileResult> {
    const id = bindingId(request.key);
    const previous = this.inFlight.get(id);
    // A caller that stopped waiting (deadline or abort) must not run its reconcile afterwards.
    let abandoned = false;
    const run: Promise<BindingReconcileResult | undefined> = (previous ?? Promise.resolve())
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => (abandoned ? undefined : this.reconcileSerialized(request)));
    this.inFlight.set(id, run);
    try {
      if (previous) {
        const waitFailure = await this.waitForQueue(previous, request);
        if (waitFailure) {
          abandoned = true;
          // The queued deadline has passed or waiting was aborted; allow the fixed read cap.
          return {
            outcome: "failed",
            failure: waitFailure,
            assignment: await this.failedResultAssignment(request, undefined),
            evidence: { initial: null, inventoryComplete: null },
          };
        }
      }
      return (await run) as BindingReconcileResult;
    } finally {
      const release = () => {
        if (this.inFlight.get(id) === run) {
          this.inFlight.delete(id);
        }
      };
      if (abandoned) {
        // An abandoned waiter's run settles only after every earlier run has, so it keeps the
        // binding's queue entry until then: a later caller must still queue behind the running one.
        void run.then(release, release);
      } else {
        release();
      }
    }
  }

  /**
   * Wait behind the binding's in-flight reconcile for at most the request's own deadline and abort
   * signal (#11342): a duplicate acquisition reports `timeout` or `cancelled` on time instead of
   * after the first one finishes. Undefined when the queue cleared in time.
   */
  private async waitForQueue(
    previous: Promise<unknown>,
    request: BindingReconcileRequest,
  ): Promise<BindingReconcileFailure | undefined> {
    try {
      await raceWithDeadline(
        previous.then(
          () => undefined,
          () => undefined,
        ),
        {
          timer: this.deps.timer,
          timeoutMs: Math.max(0, request.deadlineMs - this.deps.timer.now()),
          ...(request.signal ? { signal: request.signal } : {}),
          label: "Waiting for the binding's in-flight reconcile",
        },
      );
      return undefined;
    } catch (error) {
      logger.debug(`[Bindings] queued reconcile stopped waiting: ${errorMessage(error)}`);
      return request.signal?.aborted
        ? failure("cancelled", "Binding preparation was cancelled.")
        : failure("timeout", "Binding preparation deadline passed.");
    }
  }

  private async failedResultAssignment(
    request: BindingReconcileRequest,
    deadlineMs: number | undefined,
  ): Promise<BindingAssignmentRecord | null> {
    try {
      return await this.journal.removalRegistryStage(
        () => this.deps.registry.getAssignment(request.key),
        deadlineMs,
      );
    } catch (error) {
      if (
        error instanceof BindingJournalRemovalRegistryTimeout ||
        classifySqliteError(error) === "retryable"
      ) {
        logger.warn(
          `[Bindings] failed result assignment unavailable: ${errorMessage(error)}`,
          error,
        );
        return null;
      }
      throw error;
    }
  }

  private async reconcileSerialized(
    request: BindingReconcileRequest,
  ): Promise<BindingReconcileResult> {
    const evidence: BindingReconcileEvidence = { initial: null, inventoryComplete: null };
    try {
      return await this.reconcileSteps(request, evidence);
    } catch (error) {
      if (error instanceof ReconcileAbort || classifySqliteError(error) === "retryable") {
        // Busy writes opened no transaction; accepted journal work stays durable for redrive.
        // Return through acquisition's normal failure path so earlier sessions are backed out.
        return {
          outcome: "failed",
          failure:
            error instanceof ReconcileAbort
              ? error.failure
              : failure("discovery_incomplete", errorMessage(error)),
          assignment: await this.failedResultAssignment(request, request.deadlineMs),
          evidence,
        };
      }
      throw error;
    }
  }

  private async reconcileSteps(
    request: BindingReconcileRequest,
    evidence: BindingReconcileEvidence,
  ): Promise<BindingReconcileResult> {
    const { registry } = this.deps;
    this.checkBudget(request);
    // Resolve first: an unsupported spec fails before any registry or device mutation.
    const resolution = await this.deps.resolver.resolve(request.platform, request.requestedSpec, {
      signal: request.signal,
    });
    if (resolution.kind === "unsupported") {
      throw new ReconcileAbort(failure(resolution.code, resolution.message));
    }
    if (resolution.kind === "unresolved") {
      throw new ReconcileAbort(failure("discovery_incomplete", resolution.message));
    }
    const context: ReconcileContext = {
      request,
      resolvedSpec: resolution.resolvedSpec,
      fingerprint: resolution.fingerprint,
      evidence,
    };

    const init = await registry.initBinding(request.key, {
      role: request.role,
      platform: request.platform,
      requestedSpec: request.requestedSpec,
    });
    if (init.kind === "scope_not_valid") {
      throw new ReconcileAbort(failure("scope_not_valid", "Binding scope is not valid."));
    }
    const redriven = await this.redriveUnfinished(request, init.assignment, evidence);
    const assignment = await this.recoverIfSettled(request, redriven);
    evidence.initial = {
      generation: assignment.generation,
      stableDeviceId: assignment.stableDeviceId,
      state: assignment.state,
    };
    this.assertBindingAcceptsWork(request, assignment);
    if (assignment.platform !== request.platform) {
      return await this.changePlatform(context, assignment);
    }

    const discover = async () => {
      const inventory = await this.deps.inventory.list(request.platform, {
        signal: request.signal,
      });
      evidence.inventoryComplete = inventory.complete;
      this.checkBudget(request);
      return inventory;
    };
    const inventory =
      assignment.stableDeviceId === null
        ? await this.withEmptyBindingCleanup(context, assignment, discover)
        : await discover();

    if (assignment.stableDeviceId === null) {
      return await this.fillEmptyBinding(context, assignment, inventory);
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

  /**
   * Converge an earlier attempt's unfinished journaled work on this binding (a crash mid-replace,
   * mid-create or mid-release) before deciding anything, then re-read the binding.
   */
  private async redriveUnfinished(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
    evidence: BindingReconcileEvidence,
  ): Promise<BindingAssignmentRecord> {
    const redrive = await this.journal.redriveBinding(request.key);
    if (redrive.redriven.length > 0) {
      evidence.redriven = redrive.redriven;
    }
    if (redrive.kind === "blocked") {
      throw new ReconcileAbort(failure(redrive.reason, redrive.message));
    }
    if (redrive.redriven.length === 0) {
      return assignment;
    }
    const current = await this.deps.registry.getAssignment(request.key);
    if (!current) {
      throw new ReconcileAbort(failure("scope_not_valid", "Binding disappeared during redrive."));
    }
    return current;
  }

  /**
   * A `settling` binding whose settler is gone is settled (its work died with that process): recover
   * it to `ready` and continue. One whose settler still runs refuses retryable `binding_settling`.
   */
  private async recoverIfSettled(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
  ): Promise<BindingAssignmentRecord> {
    if (assignment.state !== "settling") {
      return assignment;
    }
    const recovered = (await this.deps.registry.recoverSettledBindings(request.key.scopeKey)).find(
      (binding) => binding.bindingIndex === request.key.bindingIndex,
    );
    if (recovered) {
      return recovered;
    }
    throw new ReconcileAbort(
      failure(
        "binding_settling",
        `Binding ${request.key.bindingIndex} is settling the released work of its previous execution.`,
      ),
    );
  }

  private assertBindingAcceptsWork(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
  ): void {
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      throw new ReconcileAbort(
        failure(
          "binding_in_use",
          `Binding ${request.key.bindingIndex} is held by live session ${assignment.execOwner.sessionUuid}.`,
        ),
      );
    }
    if (assignment.state === "cleanup_pending") {
      throw new ReconcileAbort(
        failure(
          "cleanup_pending",
          `Binding ${request.key.bindingIndex} still holds device '${assignment.stableDeviceId}' pending cleanup.`,
        ),
      );
    }
    if (assignment.state === "replacing") {
      // The journal redrive above already converged any dead owner's replacement (#11179); one
      // still replacing here is being driven by a live owner, so never guess.
      throw new ReconcileAbort(
        failure(
          "reconcile_in_progress",
          `Binding ${request.key.bindingIndex} is mid-replacement of '${assignment.stableDeviceId}'.`,
        ),
      );
    }
  }

  // --- platform change -------------------------------------------------------------------------

  /**
   * The binding is requested on another platform (owner decision 2026-10-09, #11232): a replacement
   * like any spec change. The old platform's device is deleted and verified absent under the
   * journaled replace (its entry records both platforms), the binding moves to the new platform with
   * an empty binding, and a device of the new platform is created into the same binding.
   */
  private async changePlatform(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
  ): Promise<ReadyResult> {
    const { request, evidence } = context;
    if (assignment.stableDeviceId === null) {
      const inventory = await this.withEmptyBindingCleanup(context, assignment, async () => {
        const inventory = await this.deps.inventory.list(request.platform, {
          signal: request.signal,
        });
        evidence.inventoryComplete = inventory.complete;
        this.checkBudget(request);
        return inventory;
      });
      return await this.fillEmptyBinding(context, assignment, inventory);
    }
    const inventory = await this.deps.inventory.list(assignment.platform, {
      signal: request.signal,
    });
    evidence.inventoryComplete = inventory.complete;
    this.checkBudget(request);
    const assigned = inventory.devices.find(
      (device) =>
        device.platform === assignment.platform &&
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
      // Removed out of band: complete discovery proves absence, so nothing is left to delete.
      evidence.assignedMissing = true;
      await this.assertCreatable(context);
      const moved = await this.emptyOnRequestedPlatform(context, assignment);
      return await this.createAndCommit(context, moved, "created");
    }
    // A device of another platform can never satisfy the spec.
    evidence.assignedMatch = "mismatch";
    return await this.replaceAssigned(context, assignment, assigned, inventory.complete);
  }

  /** Empty the binding onto the requested platform (generation + 1); only when no device is bound. */
  private async emptyOnRequestedPlatform(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
  ): Promise<BindingAssignmentRecord> {
    const { request } = context;
    const emptied = await this.deps.registry.commitBinding(request.key, expectationOf(assignment), {
      platform: request.platform,
      stableDeviceId: null,
      deviceName: null,
      requestedSpec: request.requestedSpec,
      resolvedSpec: null,
      specFingerprint: null,
      state: "provisioning",
    });
    if (emptied.kind !== "committed") {
      throw new ReconcileAbort(casFailure(emptied, "platform change"));
    }
    return emptied.assignment;
  }

  // --- reuse -----------------------------------------------------------------------------------

  private async reuseAssigned(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
  ): Promise<ReadyResult> {
    // No capacity pre-check: booting the binding's own device is the provision path's decision, which
    // exempts a boot target that already holds its binding (booted, booting, or running unseen).
    // Before reserving: a reservation would take the binding over from the live execution's record.
    this.assertNoLiveExecutionOn(context, device);
    // Reserve the binding before binding a session to its device, so a concurrent replacement can
    // neither fence nor delete the device while this attempt provisions it.
    const reservation = await this.reserveExecution(context, assignment);
    try {
      return await this.reuseReserved(context, assignment, device, reservation);
    } catch (error) {
      if (reservation) {
        await this.releaseReservation(context.request.key, reservation);
      }
      throw error;
    } finally {
      // Superseded by the real claim or released: it no longer keeps the binding in use (#11339).
      if (reservation) {
        this.reservations.delete(reservation);
      }
    }
  }

  private async reuseReserved(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
    reservation: string | undefined,
  ): Promise<ReadyResult> {
    context = { ...context, resolvedSpec: await this.existingSpec(device) };
    // The binding's own device is excluded from every other caller and the registry records no live
    // execution, so any session on it is an earlier execution's leftover, unless this daemon still
    // holds it as a live execution (#11275), which refuses with binding_in_use instead.
    const provisioned = await this.provisionExisting(context, device, { releaseStale: true });
    return await this.readyOrReleaseOnBusy(provisioned, async () => {
      const expected = expectationOf(assignment);
      const fingerprint = encodeManagedSpecFingerprint(context.fingerprint);
      const unchanged =
        assignment.state === "ready" &&
        assignment.specFingerprint === fingerprint &&
        stableStringify(assignment.requestedSpec) ===
          stableStringify(context.request.requestedSpec) &&
        this.resolvedIdentityMatches(assignment.resolvedSpec, context.resolvedSpec);
      // Repair an older binding's creation-default metadata once; subsequent identical requests
      // retain the generation. A full AVD config read adds detail beyond the resolver's fields,
      // without changing the binding. The fingerprint still describes the resolver's creation choice.
      // An unchanged ready binding is only re-verified; a new spec or a not-yet-ready binding is
      // recorded as a new generation of the same device.
      const committed = unchanged
        ? await this.deps.registry.updateBindingState(context.request.key, expected, "ready")
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
    });
  }

  private resolvedIdentityMatches(stored: unknown, actual: BindingResolvedSpec): boolean {
    if (stored === null || typeof stored !== "object") {
      return false;
    }
    return (["runtime", "deviceType", "displayCutout"] as const).every(
      (key) => Reflect.get(stored, key) === actual[key],
    );
  }

  /** Claim a ready, assigned binding for a placeholder session before provisioning, when owned. */
  private async reserveExecution(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
  ): Promise<string | undefined> {
    const { owner, key } = context.request;
    if (!owner || assignment.state !== "ready") {
      return undefined;
    }
    const reservation = `reserve-${this.idGenerator.next()}`;
    // Recorded before the claim: the registry judges the new record by this set (#11339).
    this.reservations.add(reservation);
    try {
      const claimed = await this.deps.registry.claimExecution(key, expectationOf(assignment), {
        ...owner,
        sessionUuid: reservation,
      });
      if (claimed.kind !== "claimed") {
        throw new ReconcileAbort(claimFailure(claimed, "reservation"));
      }
    } catch (error) {
      this.reservations.delete(reservation);
      throw error;
    }
    return reservation;
  }

  private async releaseReservation(key: BindingKey, reservation: string): Promise<void> {
    try {
      await this.deps.registry.releaseExecution(key, reservation);
    } catch (error) {
      // The reservation is no longer in flight, so the registry judges a leaked record dead and
      // the next claim takes the binding over (#11339); log it so a stuck binding has a trace.
      logger.warn(
        `[Bindings] releasing reservation ${reservation} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  // --- empty binding: adopt or create -------------------------------------------------------------

  private async fillEmptyBinding(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    inventory: BindingInventorySnapshot,
  ): Promise<ReadyResult> {
    const candidate = await this.withEmptyBindingCleanup(context, assignment, async () => {
      if (!inventory.complete) {
        // Without complete discovery we can neither find adoptable devices nor rule out a
        // leftover of this binding, so do nothing rather than create a duplicate.
        throw new ReconcileAbort(
          failure("discovery_incomplete", "Device discovery was incomplete for an empty binding."),
        );
      }
      const candidate = await this.findAdoptionCandidate(context, inventory.devices);
      // Validate creation before moving an empty binding; adoption needs no creation catalog.
      if (assignment.platform !== context.request.platform && !candidate) {
        await this.assertCreatable(context);
      }
      return candidate;
    });
    if (assignment.platform !== context.request.platform) {
      assignment = await this.emptyOnRequestedPlatform(context, assignment);
    }
    if (candidate) {
      return await this.adopt(context, assignment, candidate.device, candidate.source);
    }
    return await this.createAndCommit(context, assignment, "created");
  }

  private async findAdoptionCandidate(
    context: ReconcileContext,
    devices: DeviceInfo[],
  ): Promise<{ device: DeviceInfo; source: "orphan" } | undefined> {
    const { request } = context;
    const suffix = bindingDeviceNameSuffix(request.key);
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
      // Preserve the binding-specific adoption fence across both product name generations.
      const source =
        isProductBrokerDevice(device.name) &&
        device.name.slice(device.name.indexOf("-") + 1).startsWith(suffix)
          ? "orphan"
          : undefined;
      if (!source) {
        continue;
      }
      if (source === "orphan") {
        // A leftover of this binding's interrupted create is adoptable only if nobody holds it: no
        // binding, and no session (product names are excluded from generic clients).
        const holder = await this.deps.registry.findDeviceHolder(request.platform, stableId);
        if (holder || this.sessionsOn(device).length > 0) {
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
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
    source: "orphan",
  ): Promise<ReadyResult> {
    context = { ...context, resolvedSpec: await this.existingSpec(device) };
    const { request } = context;
    const stableId = deviceStableId(device)!;
    // Commit first: the CAS atomically takes the device out of the free pool and reserves it,
    // so a failed provision leaves the binding bound (`provisioning`) and the next attempt reuses.
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
    // A free-pool device is excluded from generic clients, so a session on it is a leftover
    // managed execution; an orphan's is not ours to end.
    const provisioned = await this.provisionExisting(context, device, {
      releaseStale: false,
    });
    return await this.readyOrReleaseOnBusy(provisioned, async () => {
      const ready = await this.deps.registry.updateBindingState(
        request.key,
        expectationOf(reserved.assignment),
        "ready",
      );
      if (ready.kind !== "updated") {
        await this.releaseSession(provisioned.sessionUuid);
        throw new ReconcileAbort(claimFailure(ready, "adoption"));
      }
      return await this.claimAndReady(context, "adopted", ready.assignment, provisioned, undefined);
    });
  }

  private async existingSpec(device: DeviceInfo): Promise<BindingResolvedSpec> {
    const spec = await this.deps.provisioner.readExistingSpec(device);
    if (!spec) {
      throw new ReconcileAbort(
        failure(
          "discovery_incomplete",
          `The configuration of device '${device.name}' could not be read.`,
        ),
      );
    }
    return spec;
  }

  /**
   * Create a device under the binding's next generated name and commit it, journaled so an
   * interruption at any boundary converges: `creating` (provision issued) → `created` (device
   * exists) → `committed` together with the binding. `replacing` continues a replacement entry that
   * already verified the old device's absence.
   */
  private async createAndCommit(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    disposition: "created" | "replaced",
    replacing?: BindingJournalEntry,
    options: { capacityAsserted?: boolean } = {},
  ): Promise<ReadyResult> {
    const { request } = context;
    if (replacing === undefined) {
      try {
        this.checkBudget(request);
        await this.assertCreatable(context);
        if (!options.capacityAsserted) {
          await this.assertBootCapacity(request);
        }
      } catch (error) {
        // No provisioning or journal entry exists yet; preserve the original refusal unchanged.
        await this.removeNeverBoundBinding(context, assignment, "pre-provision refusal");
        throw error;
      }
    } else {
      this.checkBudget(request);
      // A replacement asserted capacity before deleting, counting the binding its old device frees;
      // asking again here could refuse after deletion while that device is still being counted.
      if (!options.capacityAsserted) {
        await this.assertBootCapacity(request);
      }
    }
    const name = bindingDeviceName(request.key, assignment.generation + 1, this.idGenerator.next());
    context.evidence.createdName = name;
    let entry = replacing
      ? await this.advanceToCreating(context, replacing, name)
      : await this.openCreateEntry(context, assignment, name);
    this.journal.inFlight.add(entry.id);
    try {
      if (replacing === undefined && this.deps.resourceBudget) {
        await this.admitFreshCreation(context, assignment, entry);
      }
      let provisioned: BindingProvisionedDevice;
      try {
        provisioned = await this.deps.provisioner.provision({
          platform: request.platform,
          name,
          // "Any model" creates the model the resolver chose (and recorded).
          spec: {
            ...provisionableSpec(request.requestedSpec),
            deviceType: context.resolvedSpec.deviceType,
          },
          mode: "create",
          deadlineMs: request.deadlineMs,
          signal: request.signal,
        });
      } catch (error) {
        // The provision path rolls back its own partial creation; settle the entry on proof of
        // absence, or leave it open for redrive when a leftover may exist.
        const settled = await this.settleFailedCreate(context, entry);
        if (replacing === undefined) {
          await this.removeFailedUnboundBinding(context, assignment, settled);
        }
        throw new ReconcileAbort(provisionFailure(error));
      }
      return await this.readyOrReleaseOnBusy(provisioned, async (release) => {
        if (provisioned.created && !this.isAutomationReady(provisioned)) {
          this.journal.markRemovalIntended(entry);
        }
        entry = await this.recordCreated(context, entry, provisioned, release);
        if (!this.isAutomationReady(provisioned)) {
          return await this.discardUncommitted(
            context,
            provisioned,
            entry,
            release,
            failure("readiness_incomplete", `Device '${name}' did not reach automation readiness.`),
          );
        }
        const committed = await this.journal.advance(entry, {
          expectedPhase: "created",
          phase: "committed",
          assignment: {
            kind: "commit",
            expected: entry.binding,
            next: {
              stableDeviceId: provisioned.device.stableId,
              deviceName: provisioned.device.name,
              requestedSpec: request.requestedSpec,
              resolvedSpec: context.resolvedSpec,
              specFingerprint: encodeManagedSpecFingerprint(context.fingerprint),
              state: "ready",
            },
          },
        });
        if (committed.kind === "journal_conflict") {
          // Another driver took the entry over; it owns the device's fate now.
          await this.releaseSession(provisioned.sessionUuid);
          throw new ReconcileAbort(
            failure("concurrent_modification", "The binding's journal entry was taken over."),
          );
        }
        if (committed.kind !== "advanced") {
          return await this.discardUncommitted(
            context,
            provisioned,
            entry,
            release,
            claimFailure(committed, "create commit"),
          );
        }
        this.noteJournal(context, committed.entry);
        return await this.claimAndReady(
          context,
          disposition,
          committed.assignment!,
          provisioned,
          undefined,
        );
      });
    } finally {
      this.journal.inFlight.delete(entry.id);
    }
  }

  private async openCreateEntry(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    name: string,
  ): Promise<BindingJournalEntry> {
    const { request } = context;
    const opened = await this.deps.registry.openBindingJournal(request.key, {
      kind: "create",
      phase: "creating",
      owner: this.journal.owner,
      target: this.journalTarget(context, assignment, name),
      assignment: { kind: "state", expected: expectationOf(assignment), state: "provisioning" },
    });
    if (opened.kind === "journal_open") {
      throw new ReconcileAbort(
        failure(
          "reconcile_in_progress",
          `Binding ${request.key.bindingIndex} has unfinished work.`,
        ),
      );
    }
    if (opened.kind !== "opened") {
      throw new ReconcileAbort(claimFailure(opened, "create"));
    }
    this.noteJournal(context, opened.entry);
    return opened.entry;
  }

  private async advanceToCreating(
    context: ReconcileContext,
    entry: BindingJournalEntry,
    name: string,
  ): Promise<BindingJournalEntry> {
    const advanced = await this.journal.advance(entry, {
      expectedPhase: "deleted",
      phase: "creating",
      target: { newName: name },
    });
    if (advanced.kind !== "advanced") {
      throw new ReconcileAbort(
        failure("concurrent_modification", `Replacement journal changed: ${advanced.kind}.`),
      );
    }
    this.noteJournal(context, advanced.entry);
    return advanced.entry;
  }

  private async recordCreated(
    context: ReconcileContext,
    entry: BindingJournalEntry,
    provisioned: BindingProvisionedDevice,
    release: () => Promise<void>,
  ): Promise<BindingJournalEntry> {
    const recorded = await this.journal
      .advance(entry, {
        expectedPhase: "creating",
        phase: "created",
        target: {
          newStableId: provisioned.device.stableId,
          newName: provisioned.device.name,
          ...(provisioned.created && !this.isAutomationReady(provisioned)
            ? { removalRequested: true }
            : {}),
        },
      })
      .catch(async (error: unknown) => {
        logger.warn(`[Bindings] recording created device failed: ${errorMessage(error)}`, error);
        await release();
        throw error;
      });
    if (recorded.kind !== "advanced") {
      // Another driver took the entry over and will settle the device by its recorded name.
      await release();
      throw new ReconcileAbort(
        failure("concurrent_modification", "The binding's journal entry was taken over."),
      );
    }
    this.noteJournal(context, recorded.entry);
    return recorded.entry;
  }

  /** Reserve total-resource capacity before any native creation. */
  private async admitFreshCreation(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    entry: BindingJournalEntry,
  ): Promise<void> {
    let admission: BindingResourceAdmission;
    try {
      admission = await this.deps.resourceBudget!.admitCreation({
        journalEntryId: entry.id,
        deadlineMs: context.request.deadlineMs,
        signal: context.request.signal,
      });
      // Admission can consume the remaining preparation time even when it finds room.
      this.checkBudget(context.request);
    } catch (error) {
      const settled = await this.settleFailedCreate(context, entry, true);
      await this.removeFailedUnboundBinding(context, assignment, settled);
      // Cancellation retains its identity for the reconciler's existing handling.
      throw error;
    }
    if (admission.kind === "admitted") {
      return;
    }
    // Native creation has not been called: absence is already proven, including when discovery
    // itself is incomplete. Close directly rather than rediscovering a device that never existed.
    const settled = await this.settleFailedCreate(context, entry, true);
    await this.removeFailedUnboundBinding(context, assignment, settled);
    if (admission.kind === "unknown") {
      throw new ReconcileAbort(failure("discovery_incomplete", admission.message));
    }
    const { limit, usage, charged, retained, evictionFailures } = admission;
    throw new ReconcileAbort(
      failure("binding_budget_exhausted", "Managed-binding total-resource budget is exhausted.", {
        budget: { limit, usage, charged, retained, evictionFailures },
      }),
    );
  }

  private async removeFailedUnboundBinding(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    settled: BindingJournalEntry | undefined,
  ): Promise<void> {
    if (settled?.phase !== "rolled_back") {
      return;
    }
    await this.removeNeverBoundBinding(context, assignment, `failed creation entry ${settled.id}`);
  }

  private async withEmptyBindingCleanup<T>(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // removeNeverBoundBinding logs cleanup failures and preserves the original refusal.
      await this.removeNeverBoundBinding(context, assignment, "empty-binding discovery refusal");
      throw error;
    }
  }

  private async removeNeverBoundBinding(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    reason: string,
  ): Promise<void> {
    if (assignment.generation !== 0 || assignment.stableDeviceId !== null) {
      return;
    }
    try {
      await this.deps.registry.removeUnboundBinding(context.request.key, {
        generation: assignment.generation,
        stableDeviceId: null,
      });
    } catch (error) {
      logger.warn(
        `[Bindings] removing never-bound binding after ${reason} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /** Roll back on proven absence; otherwise discover leftovers and retain cleanup for redrive. */
  private async settleFailedCreate(
    context: ReconcileContext,
    entry: BindingJournalEntry,
    absenceProven = false,
  ): Promise<BindingJournalEntry | undefined> {
    try {
      if (absenceProven) {
        const settled = (await this.journal.close(entry, "rolled_back")).entry;
        this.noteJournal(context, settled);
        return settled;
      }
      const settled = await this.journal.settleCreation(entry, {
        adopt: false,
        deadlineMs: context.request.deadlineMs,
      });
      this.noteJournal(context, settled.entry);
      return settled.entry;
    } catch (error) {
      logger.warn(
        `[Bindings] settling failed creation entry ${entry.id} failed; redrive will retry: ` +
          errorMessage(error),
        error,
      );
    }
  }

  /**
   * A device this attempt created but could not publish: release its session and remove it, unless
   * the registry says a binding (any scope) or the free pool now holds that stable id.
   */
  private async discardUncommitted(
    context: ReconcileContext,
    provisioned: BindingProvisionedDevice,
    entry: BindingJournalEntry,
    release: () => Promise<void>,
    reason: BindingReconcileFailure,
  ): Promise<never> {
    try {
      if (provisioned.created) {
        this.journal.markRemovalIntended(entry);
        entry = await this.journal.requestRemoval(entry, {
          deadlineMs: context.request.deadlineMs,
          signal: context.request.signal,
        });
      }
    } finally {
      await release();
    }
    try {
      await this.cleanupUncommitted(context, provisioned, entry);
    } catch (error) {
      if (error instanceof BindingJournalRemovalRegistryTimeout) {
        logger.warn(`[Bindings] uncommitted cleanup deferred: ${errorMessage(error)}`, error);
        context.evidence.uncommittedCleanup = {
          stableId: provisioned.device.stableId,
          removed: false,
          message: error.message,
        };
      } else if (classifySqliteError(error) !== "retryable") {
        logger.warn(`[Bindings] uncommitted cleanup failed: ${errorMessage(error)}`, error);
        throw error;
      }
      // The durable entry stays open for redrive; preserve the failure that required cleanup.
      logger.debug(`[Bindings] uncommitted cleanup deferred: ${errorMessage(error)}`);
    }
    throw new ReconcileAbort(reason);
  }

  private async cleanupUncommitted(
    context: ReconcileContext,
    provisioned: BindingProvisionedDevice,
    entry: BindingJournalEntry,
  ): Promise<void> {
    if (!provisioned.created) {
      this.noteJournal(
        context,
        (
          await this.journal.removalRegistryStage(
            () => this.journal.close(entry, "rolled_back"),
            context.request.deadlineMs,
          )
        ).entry,
      );
      return;
    }
    this.noteJournal(context, entry);
    if (!entry.target.removalRequested) {
      context.evidence.uncommittedCleanup = {
        stableId: provisioned.device.stableId,
        removed: false,
        message: "Removal deferred to journal redrive or its current driver.",
      };
      // The first flag write was attempted; memory fences adoption until a later redrive.
      return;
    }
    // Losing a compare-and-set never licenses deleting the device the winner committed.
    const holder = await this.journal.removalRegistryStage(
      () =>
        this.deps.registry.findDeviceHolder(context.request.platform, provisioned.device.stableId),
      context.request.deadlineMs,
    );
    if (holder) {
      const heldBy =
        holder.kind === "binding"
          ? `binding ${holder.assignment.bindingIndex} of scope ${holder.assignment.scopeKey}`
          : "the managed free pool";
      context.evidence.uncommittedCleanup = {
        stableId: provisioned.device.stableId,
        removed: false,
        message: `kept: held by ${heldBy}`,
      };
      logger.warn(
        `[Bindings] not discarding '${provisioned.device.stableId}': it is held by ${heldBy}`,
      );
      this.noteJournal(
        context,
        (
          await this.journal.removalRegistryStage(
            () => this.journal.close(entry, "rolled_back"),
            context.request.deadlineMs,
          )
        ).entry,
      );
      return;
    }
    const settled = await this.journal.settleCreation(entry, {
      adopt: false,
      deadlineMs: context.request.deadlineMs,
    });
    this.noteJournal(context, settled.entry);
    const removed = settled.kind === "settled";
    context.evidence.uncommittedCleanup = {
      stableId: provisioned.device.stableId,
      removed,
      ...(settled.kind === "blocked" ? { message: settled.message } : {}),
    };
    if (!removed) {
      // The entry stays open with the device's exact identity, so a redrive removes it later.
      logger.warn(
        `[Bindings] uncommitted device '${provisioned.device.stableId}' was not removed: ` +
          (settled.kind === "blocked" ? settled.message : "unknown"),
      );
    }
  }

  // --- replace ---------------------------------------------------------------------------------

  private async replaceAssigned(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
    inventoryComplete: boolean,
  ): Promise<ReadyResult> {
    const { request, evidence } = context;
    const oldId = assignment.stableDeviceId!;
    // The slow catalog read must not sit between the claim checks and the journal open.
    await this.assertCreatable(context);
    await this.assertReplaceable(request, assignment, device, inventoryComplete);
    // Journal the accepted deletion together with `replacing`: from here on, an interruption is
    // redriven against this exact device and binding.
    const opened = await this.deps.registry.openBindingJournal(request.key, {
      kind: "replace",
      phase: "deleting",
      owner: this.journal.owner,
      target: this.journalTarget(context, assignment, null),
      assignment: { kind: "state", expected: expectationOf(assignment), state: "replacing" },
    });
    if (opened.kind === "journal_open") {
      throw new ReconcileAbort(
        failure(
          "reconcile_in_progress",
          `Binding ${request.key.bindingIndex} has unfinished work.`,
        ),
      );
    }
    if (opened.kind !== "opened") {
      // A live execution (or another attempt's reservation) claimed the device after our checks.
      throw new ReconcileAbort(claimFailure(opened, "replace"));
    }
    this.noteJournal(context, opened.entry);
    this.journal.inFlight.add(opened.entry.id);
    let deletedEntry: BindingJournalEntry;
    let emptied: BindingAssignmentRecord;
    try {
      const deletion = await this.journal.driveDeletion(opened.entry, {
        device,
        deadlineMs: request.deadlineMs,
        signal: request.signal,
      });
      this.noteJournal(context, deletion.entry);
      if (deletion.kind !== "deleted") {
        if (deletion.kind === "blocked") {
          evidence.deletion = deletion.evidence;
          throw new ReconcileAbort(failure(deletion.reason, deletion.message));
        }
        throw new ReconcileAbort(
          failure(
            "concurrent_modification",
            `Device '${oldId}' is no longer this binding's device.`,
          ),
        );
      }
      evidence.deletion = deletion.evidence;
      evidence.deletedStableId = oldId;
      deletedEntry = deletion.entry;
      emptied = deletion.assignment;
    } finally {
      this.journal.inFlight.delete(opened.entry.id);
    }
    return await this.createAndCommit(context, emptied, "replaced", deletedEntry, {
      capacityAsserted: true,
    });
  }

  private journalTarget(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    newName: string | null,
  ) {
    return {
      oldStableId: assignment.stableDeviceId,
      oldName: assignment.deviceName,
      // The old device lives on the binding's platform (the entry's); a cross-platform replacement
      // records the platform it creates on (#11232).
      ...(assignment.platform !== context.request.platform
        ? { newPlatform: context.request.platform }
        : {}),
      newName,
      newStableId: null,
      requestedSpec: context.request.requestedSpec,
      resolvedSpec: context.resolvedSpec,
      specFingerprint: encodeManagedSpecFingerprint(context.fingerprint),
    };
  }

  private noteJournal(context: ReconcileContext, entry: BindingJournalEntry): void {
    context.evidence.journal = { entryId: entry.id, kind: entry.kind, phase: entry.phase };
  }

  /**
   * Every precondition for destroying the binding's device: complete discovery, no live claim, boot
   * capacity for the replacement, and the registry still naming this exact binding as its holder.
   */
  private async assertReplaceable(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
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
    // Fail before deleting: only a device holding a boot binding of the platform being booted frees one.
    const freedBootBindings =
      assignment.platform === request.platform && holdsBootBinding(device) ? 1 : 0;
    await this.assertBootCapacity(request, freedBootBindings);
    this.checkBudget(request);
    const holder = await this.deps.registry.findDeviceHolder(assignment.platform, oldId);
    if (
      holder?.kind !== "binding" ||
      holder.assignment.scopeKey !== request.key.scopeKey ||
      holder.assignment.bindingIndex !== request.key.bindingIndex ||
      !bindingMatches(holder.assignment, expectationOf(assignment))
    ) {
      throw new ReconcileAbort(
        failure("concurrent_modification", `Device '${oldId}' is no longer this binding's device.`),
      );
    }
  }

  // --- shared steps ----------------------------------------------------------------------------

  /** Successful creation checks are shared by all steps of this reconcile only. */
  private async assertCreatable(context: ReconcileContext): Promise<void> {
    if (context.creatabilityChecked) {
      return;
    }
    const { request } = context;
    const result = await this.deps.resolver.checkCreatable?.(
      request.platform,
      // Creation paths retain resolve()'s exact spec; only reuse/adopt can widen this type.
      context.resolvedSpec as ResolvedExactDeviceSpecification,
      { signal: request.signal },
    );
    // Cancellation or expiry while discovery was pending wins over its result.
    this.checkBudget(request);
    if (result?.kind === "unsupported") {
      throw new ReconcileAbort(failure(result.code, result.message));
    }
    if (result?.kind === "unresolved") {
      throw new ReconcileAbort(failure("discovery_incomplete", result.message));
    }
    context.creatabilityChecked = true;
  }

  /** Sessions this daemon holds on `device` (none when the claims port cannot tell). */
  private sessionsOn(device: DeviceInfo): string[] {
    return this.deps.claims.sessionsOn?.(device) ?? [];
  }

  /**
   * Every execution gets a fresh session: end the sessions earlier executions left on the device
   * (or refuse, when they are not ours to end) before provisioning binds it, and refuse a provision
   * that still hands one of them back.
   */
  private async releaseStaleSessions(
    context: ReconcileContext,
    device: DeviceInfo,
    releaseStale: boolean,
  ): Promise<ReadonlySet<string>> {
    const stale = this.sessionsOn(device);
    if (stale.length === 0) {
      return new Set();
    }
    if (!releaseStale) {
      throw new ReconcileAbort(
        failure(
          "device_busy",
          `Device '${device.name}' is held by session(s) ${stale.join(", ")}.`,
        ),
      );
    }
    this.assertNoLiveExecutionOn(context, device, stale);
    try {
      await Promise.all(
        stale.map((sessionUuid) => this.deps.provisioner.releaseSession(sessionUuid)),
      );
    } catch (error) {
      logger.warn(
        `[Bindings] releasing stale session(s) on '${device.name}' failed: ${errorMessage(error)}`,
        error,
      );
      throw new ReconcileAbort(
        failure(
          "stale_session",
          `An earlier execution's session on '${device.name}' could not be released: ${errorMessage(error)}`,
        ),
      );
    }
    context.evidence.releasedStaleSessions = stale;
    return new Set(stale);
  }

  /**
   * Refuse with a retryable `binding_in_use` when this daemon still holds a session on the device as a
   * live managed execution (#11275): a duplicate acquisition must never release it.
   */
  private assertNoLiveExecutionOn(
    context: ReconcileContext,
    device: DeviceInfo,
    sessions: readonly string[] = this.sessionsOn(device),
  ): void {
    const live = sessions.find((sessionUuid) => this.deps.claims.isLiveExecution?.(sessionUuid));
    if (live !== undefined) {
      throw new ReconcileAbort(
        failure(
          "binding_in_use",
          `Binding ${context.request.key.bindingIndex} is held by live session ${live} on '${device.name}'.`,
        ),
      );
    }
  }

  private async provisionExisting(
    context: ReconcileContext,
    device: DeviceInfo,
    options: { releaseStale: boolean },
  ): Promise<BindingProvisionedDevice> {
    const { request } = context;
    const stale = await this.releaseStaleSessions(context, device, options.releaseStale);
    let provisioned: BindingProvisionedDevice;
    try {
      provisioned = await this.deps.provisioner.provision({
        platform: request.platform,
        name: device.name,
        ...(request.platform === "ios" && device.deviceId ? { deviceId: device.deviceId } : {}),
        spec: provisionableSpec(request.requestedSpec),
        mode: "adopt",
        deadlineMs: request.deadlineMs,
        signal: request.signal,
      });
    } catch (error) {
      throw new ReconcileAbort(provisionFailure(error));
    }
    if (stale.has(provisioned.sessionUuid)) {
      // Never hand an earlier execution's session to this one.
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(
        failure(
          "stale_session",
          `Provisioning '${device.name}' returned earlier session ${provisioned.sessionUuid}.`,
        ),
      );
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

  private isAutomationReady(provisioned: BindingProvisionedDevice): boolean {
    return (
      provisioned.sessionUuid.length > 0 &&
      provisioned.readiness.mode === "automation" &&
      provisioned.readiness.status === "automation_ready"
    );
  }

  /**
   * Fail immediately at the boot limit before creating a device (and before deleting the one it
   * replaces). `freedBootBindings` counts binding-holding devices the caller is about to delete; an
   * unknown count is never free capacity. Booting a device that already exists is not checked
   * here: the provision path owns that decision and its own-target exemption.
   */
  private async assertBootCapacity(
    request: BindingReconcileRequest,
    freedBootBindings = 0,
  ): Promise<void> {
    if (!this.deps.capacity) {
      return;
    }
    const check = await this.deps.capacity.check(request.platform, { signal: request.signal });
    if (check.kind === "unknown") {
      throw new ReconcileAbort(failure("discovery_incomplete", check.message));
    }
    if (check.kind === "exhausted" && check.booted - freedBootBindings >= check.limit) {
      throw new ReconcileAbort(
        failure(
          "capacity_exhausted",
          `${check.booted} ${request.platform} device(s) booted; limit is ${check.limit}.`,
          {
            capacity: {
              limit: check.limit,
              booted: check.booted,
              retryAfterMs: check.retryAfterMs,
              ...externalDevicesField(check.externalDevices),
            },
          },
        ),
      );
    }
  }

  private async releaseSession(sessionUuid: string): Promise<void> {
    try {
      await this.deps.provisioner.releaseSession(sessionUuid);
    } catch (error) {
      logger.warn(
        `[Bindings] releasing unpublished session ${sessionUuid} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private checkBudget(request: BindingReconcileRequest): void {
    if (request.signal?.aborted) {
      throw new ReconcileAbort(failure("cancelled", "Binding preparation was cancelled."));
    }
    if (this.deps.timer.now() >= request.deadlineMs) {
      throw new ReconcileAbort(failure("timeout", "Binding preparation deadline passed."));
    }
  }

  /**
   * Hand the binding to the request's execution (superseding its own reservation) under the binding
   * just committed, then report ready. A lost claim releases the session it would have published.
   */
  private async claimAndReady(
    context: ReconcileContext,
    disposition: BindingDisposition,
    assignment: BindingAssignmentRecord,
    provisioned: BindingProvisionedDevice,
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

  /** A busy publish cannot hand out its freshly provisioned session; release it before refusing. */
  private async readyOrReleaseOnBusy(
    provisioned: BindingProvisionedDevice,
    publish: (release: () => Promise<void>) => Promise<ReadyResult>,
  ): Promise<ReadyResult> {
    let released = false;
    const release = async () => {
      if (!released) {
        released = true;
        await this.releaseSession(provisioned.sessionUuid);
      }
    };
    try {
      return await publish(release);
    } catch (error) {
      if (classifySqliteError(error) === "retryable") {
        await release();
      }
      throw error;
    }
  }

  private ready(
    context: ReconcileContext,
    disposition: BindingDisposition,
    assignment: BindingAssignmentRecord,
    provisioned: BindingProvisionedDevice,
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
