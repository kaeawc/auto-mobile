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
import { evaluateRuntimeCompatibility } from "../../utils/ios-cmdline-tools/runtimeCompatibility";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../utils/ios-cmdline-tools/SimCtlClient";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { AvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultSlotExecOwnerLiveness } from "./slotOwnerLiveness";
import type { BackoffInput } from "../../utils/Backoff";
import { currentDaemonProcessGenerationToken } from "../processGeneration";
import { deviceStableId } from "./slotDeviceIdentity";
import {
  ManagedSlotJournal,
  type SlotJournalInFlight,
  type SlotJournalOwnerLiveness,
  type SlotJournalRedriveRecord,
} from "./slotJournal";
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
  type SlotJournalEntry,
  type SlotJournalOwner,
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
 * - Every create and replace is journaled (`slot_journal`, #11179) with its exact devices, and each
 *   acquisition first redrives the slot's unfinished work of a dead owner (see `slotJournal.ts`),
 *   so a retry after an interruption converges instead of repeating destructive work.
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

type WithOptionalDeviceType<T extends { deviceType: string }> = Omit<T, "deviceType"> & {
  deviceType?: string;
};

/**
 * A managed slot's requested spec: an exact spec whose `deviceType` (the model or hardware
 * profile) may be omitted. Omitted means "any model" (owner decision Q4): any listed device of the
 * requested runtime matches, and a device that must be created gets a model the resolver picks
 * and records in the resolved spec.
 */
export type ManagedSlotRequestedSpec =
  | WithOptionalDeviceType<AndroidDeviceSpecification>
  | WithOptionalDeviceType<IosDeviceSpecification>;

/**
 * The Android hardware profile created for a spec that omits `deviceType` (a current Pixel with a
 * known cutout class). Override per resolver.
 */
export const MANAGED_SLOT_DEFAULT_ANDROID_DEVICE_TYPE = "pixel_8";

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
  matches(device: DeviceInfo, spec: ManagedSlotRequestedSpec): Promise<ManagedSpecMatch>;
}

export type ManagedSpecResolution =
  | {
      kind: "resolved";
      resolvedSpec: ResolvedExactDeviceSpecification;
      fingerprint: ManagedSlotSpecFingerprint;
    }
  | { kind: "unsupported"; code: "spec_unsupported" | "runtime_incompatible"; message: string }
  /** The spec could not be resolved yet (an unreadable catalog); retryable, nothing changed. */
  | { kind: "unresolved"; message: string };

/** Validates and resolves a spec before any destructive work. */
export interface ManagedSpecResolver {
  resolve(
    platform: SlotPlatform,
    spec: ManagedSlotRequestedSpec,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecResolution>;
}

export interface ManagedSlotProvisionRequest {
  platform: SlotPlatform;
  /** Android: the AVD name (stable id). iOS: the simulator name. */
  name: string;
  /** iOS UDID of an existing simulator to adopt. */
  deviceId?: string;
  /**
   * `create` always carries a concrete `deviceType` (the resolved model). `adopt` carries the
   * requested spec, whose omitted `deviceType` accepts the existing device's model.
   */
  spec: ManagedSlotRequestedSpec;
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
  /**
   * The sessions this daemon holds on the device. Before a slot device is provisioned for a new
   * execution, any of these is a leftover of an earlier one: the provision path's bind would hand
   * it out again (bind-or-reuse), so it is released first and never reused.
   */
  sessionsOn?(device: DeviceInfo): string[];
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
  /** Whether a recorded execution owner is alive; default: PID plus process generation. */
  isExecOwnerLive?: SlotExecOwnerLiveness;
  timer: Pick<Timer, "now">;
  /** Execution-reservation ids (default: random UUIDs). */
  idGenerator?: IdGenerator;
  /** Journal ownership and redrive policy (#11179). */
  journal?: ManagedSlotReconcilerJournalOptions;
}

export interface ManagedSlotReconcilerJournalOptions {
  /** This process as a journal owner; default: this PID and its process-generation token. */
  owner?: SlotJournalOwner;
  /** Whether another journal owner is alive; default: PID plus process generation. */
  isOwnerLive?: SlotJournalOwnerLiveness;
  /** Shared with the drain and the redrive pass so one process never drives an entry twice. */
  inFlight?: SlotJournalInFlight;
  backoff?: BackoffInput;
}

/** The default journal owner: this process, by PID and process-generation token. */
export function processJournalOwner(): SlotJournalOwner {
  return {
    daemonId: `pid-${process.pid}`,
    pid: process.pid,
    processGenerationToken: currentDaemonProcessGenerationToken() ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Request and result
// ---------------------------------------------------------------------------------------------

export interface ManagedSlotReconcileRequest {
  key: SlotKey;
  role: string;
  platform: SlotPlatform;
  requestedSpec: ManagedSlotRequestedSpec;
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
  | "discovery_incomplete"
  | "slot_in_use"
  | "slot_settling"
  | "device_busy"
  | "reconcile_in_progress"
  | "cleanup_pending"
  | "capacity_exhausted"
  | "concurrent_modification"
  | "readiness_incomplete"
  | "stale_session"
  | "provision_failed"
  | "timeout"
  | "cancelled";

const FAILURE_RETRYABILITY: Readonly<Record<ManagedSlotReconcileFailureCode, boolean>> = {
  spec_unsupported: false,
  runtime_incompatible: false,
  scope_not_valid: false,
  discovery_incomplete: true,
  slot_in_use: true,
  slot_settling: true,
  device_busy: true,
  reconcile_in_progress: true,
  cleanup_pending: true,
  capacity_exhausted: true,
  concurrent_modification: true,
  readiness_incomplete: true,
  stale_session: true,
  provision_failed: false,
  timeout: true,
  cancelled: true,
};

const FAILURE_NEXT_ACTION: Readonly<Record<ManagedSlotReconcileFailureCode, string>> = {
  spec_unsupported: "Fix the requested spec; nothing was changed.",
  runtime_incompatible: "Request a model/runtime pair the host supports; nothing was changed.",
  scope_not_valid: "Use the current runner incarnation; this scope no longer accepts work.",
  discovery_incomplete: "Retry once device discovery completes; nothing destructive was done.",
  slot_in_use: "Wait for the slot's live execution to end, then retry.",
  slot_settling: "Wait for the previous execution's released work to settle, then retry.",
  device_busy: "Wait for the device's live session or foreign claim to end, then retry.",
  reconcile_in_progress: "Another reconciliation of this slot is in progress; retry later.",
  cleanup_pending: "The previous device could not be removed; retry after cleanup succeeds.",
  capacity_exhausted: "Shut down a device or raise the boot limit, then retry.",
  concurrent_modification: "The slot changed concurrently; retry to converge on its new state.",
  readiness_incomplete: "Retry; the device did not reach automation readiness.",
  stale_session: "Retry; an earlier execution's session on the slot device could not be released.",
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
  /** Unfinished journaled work of an earlier attempt this acquisition redrove first (#11179). */
  redriven?: SlotJournalRedriveRecord[];
  /** The journal entry this attempt opened, and the phase it reached. */
  journal?: { entryId: number; kind: SlotJournalEntry["kind"]; phase: SlotJournalEntry["phase"] };
  /** Leftover sessions of earlier executions released before provisioning, so none is reused. */
  releasedStaleSessions?: string[];
}

export type ManagedSlotReconcileResult =
  | {
      outcome: "ready";
      disposition: ManagedSlotDisposition;
      assignment: SlotAssignmentRecord;
      device: ManagedSlotDeviceIdentity;
      sessionUuid: string;
      requestedSpec: ManagedSlotRequestedSpec;
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

/**
 * `amslot-<8 hex of scope key>-<slot>-g<generation>-<attempt nonce>`, valid as an AVD and
 * simulator name. The per-attempt nonce keeps two concurrent attempts on the same slot (another
 * daemon, or a retry while the first attempt still runs) from creating the same AVD name, whose
 * name is its stable id, so one attempt's cleanup can never delete the other's device.
 */
export function managedSlotDeviceName(key: SlotKey, generation: number, nonce: string): string {
  const safeNonce = nonce
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  if (safeNonce.length === 0) {
    throw new Error(`Managed slot device name nonce '${nonce}' has no usable characters`);
  }
  return `${managedSlotDeviceNamePrefix(key)}${generation}-${safeNonce}`;
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

export { deviceStableId };

/** Matches with the shared exact-provisioning matchers (#11100) — one definition of "matches". */
export class DefaultManagedSpecMatcher implements ManagedSpecMatcher {
  constructor(private readonly androidConfigReader: Pick<AvdConfigReader, "readConfig">) {}

  async matches(device: DeviceInfo, spec: ManagedSlotRequestedSpec): Promise<ManagedSpecMatch> {
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
      // An omitted hardware profile is unconstrained: the AVD's own profile (even an unset one)
      // satisfies it.
      const constraints = {
        ...(spec as WithOptionalDeviceType<AndroidDeviceSpecification>),
        deviceType: (spec.deviceType ?? config.deviceName) as string,
      };
      return matchesAndroidDeviceSpecification(constraints, config) ? "match" : "mismatch";
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
    return iosDeviceSpecificationMismatch(constraints, device) === undefined ? "match" : "mismatch";
  }
}

const IOS_RUNTIME_IDENTIFIER_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

/** The Android system-image packages installed in the SDK, as `system-images;...` identifiers. */
export interface ManagedAndroidImageCatalog {
  listInstalledPackages(signal?: AbortSignal): Promise<string[]>;
}

export interface DefaultManagedSpecResolverOptions {
  /** Profile created for an Android spec that omits `deviceType`. */
  androidDefaultDeviceType?: string;
  /**
   * With a catalog, an Android spec whose system image is not installed is refused as
   * `spec_unsupported` before anything is created, instead of surfacing avdmanager's raw text.
   */
  androidImageCatalog?: ManagedAndroidImageCatalog;
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
 * {@link MANAGED_SLOT_DEFAULT_ANDROID_DEVICE_TYPE} unless overridden. Matching still accepts any
 * model; only creation uses the resolved one. A cutout preference needs an explicit model.
 */
export class DefaultManagedSpecResolver implements ManagedSpecResolver {
  private readonly androidDefaultDeviceType: string;
  private readonly androidImageCatalog?: ManagedAndroidImageCatalog;

  constructor(
    private readonly iosRuntimeCatalog?: ExactIosRuntimeCatalog,
    options: DefaultManagedSpecResolverOptions = {},
  ) {
    this.androidDefaultDeviceType =
      options.androidDefaultDeviceType ?? MANAGED_SLOT_DEFAULT_ANDROID_DEVICE_TYPE;
    this.androidImageCatalog = options.androidImageCatalog;
  }

  async resolve(
    platform: SlotPlatform,
    spec: ManagedSlotRequestedSpec,
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
    const exact = { ...spec, deviceType: model.deviceType } as ExactDeviceSpecification;
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
    platform: SlotPlatform,
    spec: ManagedSlotRequestedSpec,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
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
    platform: SlotPlatform,
    spec: ManagedSlotRequestedSpec,
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
      return { kind: "resolved", deviceType: this.androidDefaultDeviceType };
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
        `[ManagedSlots] iOS catalog unreadable; cannot choose a model: ${errorMessage(error)}`,
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
    const deviceType = chooseIosDeviceType(spec.runtime, runtimes, deviceTypes);
    return deviceType
      ? { kind: "resolved", deviceType }
      : refused(
          "runtime_incompatible",
          `No installed iPhone model supports runtime '${spec.runtime}', or the runtime is not available.`,
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
      logger.warn(`[ManagedSlots] Android image check skipped: ${errorMessage(error)}`, error);
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
    spec: ManagedSlotRequestedSpec,
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
      logger.warn(`[ManagedSlots] iOS catalog check skipped: ${errorMessage(error)}`, error);
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

function refused(
  code: "spec_unsupported" | "runtime_incompatible",
  message: string,
): { kind: "refused"; resolution: ManagedSpecResolution } {
  return { kind: "refused", resolution: { kind: "unsupported", code, message } };
}

/**
 * The model "any model" creates for an iOS runtime: the last (newest, in simctl's catalog order)
 * iPhone whose runtime range supports it, else the last iPhone with no range metadata (simctl
 * stays the authority). Undefined when the runtime is missing or unavailable, or no iPhone fits.
 */
export function chooseIosDeviceType(
  runtimeId: string,
  runtimes: readonly AppleDeviceRuntime[],
  deviceTypes: readonly AppleDeviceType[],
): string | undefined {
  const runtime = runtimes.find((entry) => entry.identifier === runtimeId);
  if (!runtime?.isAvailable) {
    return undefined;
  }
  const iphones = deviceTypes.filter((entry) => entry.productFamily === "iPhone");
  const statusOf = (entry: AppleDeviceType) =>
    evaluateRuntimeCompatibility(entry, runtime.version).status;
  const supported = iphones.filter((entry) => statusOf(entry) === "supported");
  const unknown = iphones.filter((entry) => statusOf(entry) === "unknown");
  return (supported.at(-1) ?? unknown.at(-1))?.identifier;
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
  result:
    | SlotCasFailure
    | { kind: "slot_in_use"; owner: SlotExecOwner }
    | { kind: "slot_not_ready" },
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

  readonly journal: ManagedSlotJournal;

  constructor(private readonly deps: ManagedSlotReconcilerDependencies) {
    this.isExecOwnerLive = deps.isExecOwnerLive ?? defaultSlotExecOwnerLiveness;
    this.idGenerator = deps.idGenerator ?? defaultIdGenerator;
    this.journal = new ManagedSlotJournal({
      registry: deps.registry,
      inventory: deps.inventory,
      matcher: deps.matcher,
      deleter: deps.deleter,
      claims: deps.claims,
      timer: deps.timer,
      owner: deps.journal?.owner ?? processJournalOwner(),
      isExecOwnerLive: this.isExecOwnerLive,
      ...(deps.journal?.isOwnerLive ? { isOwnerLive: deps.journal.isOwnerLive } : {}),
      ...(deps.journal?.inFlight ? { inFlight: deps.journal.inFlight } : {}),
      ...(deps.journal?.backoff !== undefined ? { backoff: deps.journal.backoff } : {}),
    });
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
    if (resolution.kind === "unresolved") {
      throw new ReconcileAbort(failure("discovery_incomplete", resolution.message));
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
    const redriven = await this.redriveUnfinished(request, init.assignment, evidence);
    const assignment = await this.recoverIfSettled(request, redriven);
    evidence.initial = {
      generation: assignment.generation,
      stableDeviceId: assignment.stableDeviceId,
      state: assignment.state,
    };
    this.assertSlotAcceptsWork(request, assignment);
    if (assignment.platform !== request.platform) {
      return await this.changePlatform(context, assignment);
    }

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

  /**
   * Converge an earlier attempt's unfinished journaled work on this slot (a crash mid-replace,
   * mid-create or mid-release) before deciding anything, then re-read the slot.
   */
  private async redriveUnfinished(
    request: ManagedSlotReconcileRequest,
    assignment: SlotAssignmentRecord,
    evidence: ManagedSlotReconcileEvidence,
  ): Promise<SlotAssignmentRecord> {
    const redrive = await this.journal.redriveSlot(request.key);
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
      throw new ReconcileAbort(failure("scope_not_valid", "Slot disappeared during redrive."));
    }
    return current;
  }

  /**
   * A `settling` slot whose settler is gone is settled (its work died with that process): recover
   * it to `ready` and continue. One whose settler still runs refuses retryable `slot_settling`.
   */
  private async recoverIfSettled(
    request: ManagedSlotReconcileRequest,
    assignment: SlotAssignmentRecord,
  ): Promise<SlotAssignmentRecord> {
    if (assignment.state !== "settling") {
      return assignment;
    }
    const recovered = (await this.deps.registry.recoverSettledSlots(request.key.scopeKey)).find(
      (slot) => slot.slotIndex === request.key.slotIndex,
    );
    if (recovered) {
      return recovered;
    }
    throw new ReconcileAbort(
      failure(
        "slot_settling",
        `Slot ${request.key.slotIndex} is settling the released work of its previous execution.`,
      ),
    );
  }

  private assertSlotAcceptsWork(
    request: ManagedSlotReconcileRequest,
    assignment: SlotAssignmentRecord,
  ): void {
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
      // The journal redrive above already converged any dead owner's replacement (#11179); one
      // still replacing here is being driven by a live owner, so never guess.
      throw new ReconcileAbort(
        failure(
          "reconcile_in_progress",
          `Slot ${request.key.slotIndex} is mid-replacement of '${assignment.stableDeviceId}'.`,
        ),
      );
    }
  }

  // --- platform change -------------------------------------------------------------------------

  /**
   * The slot is requested on another platform (owner decision 2026-10-09, #11232): a replacement
   * like any spec change. The old platform's device is deleted and verified absent under the
   * journaled replace (its entry records both platforms), the slot moves to the new platform with
   * an empty binding, and a device of the new platform is created into the same slot.
   */
  private async changePlatform(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
  ): Promise<ReadyResult> {
    const { request, evidence } = context;
    if (assignment.stableDeviceId === null) {
      const moved = await this.emptyOnRequestedPlatform(context, assignment);
      const inventory = await this.deps.inventory.list(request.platform, {
        signal: request.signal,
      });
      evidence.inventoryComplete = inventory.complete;
      this.checkBudget(request);
      return await this.fillEmptySlot(context, moved, inventory);
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
      const moved = await this.emptyOnRequestedPlatform(context, assignment);
      return await this.createAndCommit(context, moved, "created");
    }
    // A device of another platform can never satisfy the spec.
    evidence.assignedMatch = "mismatch";
    return await this.replaceAssigned(context, assignment, assigned, inventory.complete);
  }

  /** Empty the slot onto the requested platform (generation + 1); only when no device is bound. */
  private async emptyOnRequestedPlatform(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
  ): Promise<SlotAssignmentRecord> {
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
    // The slot's own device is excluded from every other caller and the slot has no live
    // execution, so any session on it is an earlier execution's leftover.
    const provisioned = await this.provisionExisting(context, device, { releaseStale: true });
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
        // A leftover of this slot's interrupted create is adoptable only if nobody holds it: no
        // slot, and no session (an orphan is not excluded from generic clients).
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
    // A free-pool device is excluded from generic clients, so a session on it is a leftover
    // managed execution; an orphan's is not ours to end.
    const provisioned = await this.provisionExisting(context, device, {
      releaseStale: source === "free_pool",
    });
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

  /**
   * Create a device under the slot's next generated name and commit it, journaled so an
   * interruption at any boundary converges: `creating` (provision issued) → `created` (device
   * exists) → `committed` together with the binding. `replacing` continues a replacement entry that
   * already verified the old device's absence.
   */
  private async createAndCommit(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    disposition: "created" | "replaced",
    replacing?: SlotJournalEntry,
  ): Promise<ReadyResult> {
    const { request } = context;
    this.checkBudget(request);
    await this.assertBootCapacity(request, undefined);
    const name = managedSlotDeviceName(
      request.key,
      assignment.generation + 1,
      this.idGenerator.next(),
    );
    context.evidence.createdName = name;
    let entry = replacing
      ? await this.advanceToCreating(context, replacing, name)
      : await this.openCreateEntry(context, assignment, name);
    this.journal.inFlight.add(entry.id);
    try {
      let provisioned: ManagedSlotProvisionedDevice;
      try {
        provisioned = await this.deps.provisioner.provision({
          platform: request.platform,
          name,
          // "Any model" creates the model the resolver chose (and recorded).
          spec: { ...request.requestedSpec, deviceType: context.resolvedSpec.deviceType },
          mode: "create",
          deadlineMs: request.deadlineMs,
          signal: request.signal,
        });
      } catch (error) {
        // The provision path rolls back its own partial creation; settle the entry on proof of
        // absence, or leave it open for redrive when a leftover may exist.
        await this.settleFailedCreate(context, entry);
        throw new ReconcileAbort(provisionFailure(error));
      }
      entry = await this.recordCreated(context, entry, provisioned);
      if (!this.isAutomationReady(provisioned)) {
        await this.discardUncommitted(context, provisioned, entry);
        throw new ReconcileAbort(
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
          failure("concurrent_modification", "The slot's journal entry was taken over."),
        );
      }
      if (committed.kind !== "advanced") {
        await this.discardUncommitted(context, provisioned, entry);
        throw new ReconcileAbort(claimFailure(committed, "create commit"));
      }
      this.noteJournal(context, committed.entry);
      return await this.claimAndReady(
        context,
        disposition,
        committed.assignment!,
        provisioned,
        undefined,
      );
    } finally {
      this.journal.inFlight.delete(entry.id);
    }
  }

  private async openCreateEntry(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    name: string,
  ): Promise<SlotJournalEntry> {
    const { request } = context;
    const opened = await this.deps.registry.openSlotJournal(request.key, {
      kind: "create",
      phase: "creating",
      owner: this.journal.owner,
      target: this.journalTarget(context, assignment, name),
      assignment: { kind: "state", expected: expectationOf(assignment), state: "provisioning" },
    });
    if (opened.kind === "journal_open") {
      throw new ReconcileAbort(
        failure("reconcile_in_progress", `Slot ${request.key.slotIndex} has unfinished work.`),
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
    entry: SlotJournalEntry,
    name: string,
  ): Promise<SlotJournalEntry> {
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
    entry: SlotJournalEntry,
    provisioned: ManagedSlotProvisionedDevice,
  ): Promise<SlotJournalEntry> {
    const recorded = await this.journal.advance(entry, {
      expectedPhase: "creating",
      phase: "created",
      target: { newStableId: provisioned.device.stableId, newName: provisioned.device.name },
    });
    if (recorded.kind !== "advanced") {
      // Another driver took the entry over and will settle the device by its recorded name.
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(
        failure("concurrent_modification", "The slot's journal entry was taken over."),
      );
    }
    this.noteJournal(context, recorded.entry);
    return recorded.entry;
  }

  /** After a failed provision: roll the entry back on proven absence, else leave it for redrive. */
  private async settleFailedCreate(
    context: ReconcileContext,
    entry: SlotJournalEntry,
  ): Promise<void> {
    try {
      const settled = await this.journal.settleCreation(entry, {
        adopt: false,
        deadlineMs: context.request.deadlineMs,
      });
      this.noteJournal(context, settled.entry);
    } catch (error) {
      logger.warn(
        `[ManagedSlots] settling failed creation entry ${entry.id} failed; redrive will retry: ` +
          errorMessage(error),
        error,
      );
    }
  }

  /**
   * A device this attempt created but could not publish: release its session and remove it, unless
   * the registry says a slot (any scope) or the free pool now holds that stable id.
   */
  private async discardUncommitted(
    context: ReconcileContext,
    provisioned: ManagedSlotProvisionedDevice,
    entry: SlotJournalEntry,
  ): Promise<void> {
    await this.releaseSession(provisioned.sessionUuid);
    if (!provisioned.created) {
      this.noteJournal(context, (await this.journal.close(entry, "rolled_back")).entry);
      return;
    }
    // Losing a compare-and-set never licenses deleting the device the winner committed.
    const holder = await this.deps.registry.findDeviceHolder(
      context.request.platform,
      provisioned.device.stableId,
    );
    if (holder) {
      const heldBy =
        holder.kind === "slot"
          ? `slot ${holder.assignment.slotIndex} of scope ${holder.assignment.scopeKey}`
          : "the managed free pool";
      context.evidence.uncommittedCleanup = {
        stableId: provisioned.device.stableId,
        removed: false,
        message: `kept: held by ${heldBy}`,
      };
      logger.warn(
        `[ManagedSlots] not discarding '${provisioned.device.stableId}': it is held by ${heldBy}`,
      );
      this.noteJournal(context, (await this.journal.close(entry, "rolled_back")).entry);
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
        `[ManagedSlots] uncommitted device '${provisioned.device.stableId}' was not removed: ` +
          (settled.kind === "blocked" ? settled.message : "unknown"),
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
    const oldId = assignment.stableDeviceId!;
    await this.assertReplaceable(request, assignment, device, inventoryComplete);
    // Journal the accepted deletion together with `replacing`: from here on, an interruption is
    // redriven against this exact device and binding.
    const opened = await this.deps.registry.openSlotJournal(request.key, {
      kind: "replace",
      phase: "deleting",
      owner: this.journal.owner,
      target: this.journalTarget(context, assignment, null),
      assignment: { kind: "state", expected: expectationOf(assignment), state: "replacing" },
    });
    if (opened.kind === "journal_open") {
      throw new ReconcileAbort(
        failure("reconcile_in_progress", `Slot ${request.key.slotIndex} has unfinished work.`),
      );
    }
    if (opened.kind !== "opened") {
      // A live execution (or another attempt's reservation) claimed the device after our checks.
      throw new ReconcileAbort(claimFailure(opened, "replace"));
    }
    this.noteJournal(context, opened.entry);
    this.journal.inFlight.add(opened.entry.id);
    let deletedEntry: SlotJournalEntry;
    let emptied: SlotAssignmentRecord;
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
          failure("concurrent_modification", `Device '${oldId}' is no longer this slot's device.`),
        );
      }
      evidence.deletion = deletion.evidence;
      evidence.deletedStableId = oldId;
      deletedEntry = deletion.entry;
      emptied = deletion.assignment;
    } finally {
      this.journal.inFlight.delete(opened.entry.id);
    }
    return await this.createAndCommit(context, emptied, "replaced", deletedEntry);
  }

  private journalTarget(
    context: ReconcileContext,
    assignment: SlotAssignmentRecord,
    newName: string | null,
  ) {
    return {
      oldStableId: assignment.stableDeviceId,
      oldName: assignment.deviceName,
      // The old device lives on the slot's platform (the entry's); a cross-platform replacement
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

  private noteJournal(context: ReconcileContext, entry: SlotJournalEntry): void {
    context.evidence.journal = { entryId: entry.id, kind: entry.kind, phase: entry.phase };
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
    const holder = await this.deps.registry.findDeviceHolder(assignment.platform, oldId);
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
    try {
      await Promise.all(
        stale.map((sessionUuid) => this.deps.provisioner.releaseSession(sessionUuid)),
      );
    } catch (error) {
      logger.warn(
        `[ManagedSlots] releasing stale session(s) on '${device.name}' failed: ${errorMessage(error)}`,
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

  private async provisionExisting(
    context: ReconcileContext,
    device: DeviceInfo,
    options: { releaseStale: boolean },
  ): Promise<ManagedSlotProvisionedDevice> {
    const { request } = context;
    const stale = await this.releaseStaleSessions(context, device, options.releaseStale);
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
