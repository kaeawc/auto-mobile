import type { BootedDevice, DeviceInfo, Platform } from "../models";
import { ActionableError } from "../models";
import type {
  DeviceMatchCriteria,
  FormFactor,
  MatchingStrategy,
} from "../models/DeviceMatchCriteria";
import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { type Timer } from "../utils/SystemTimer";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { errorMessage } from "../utils/describeUnknownError";
import {
  describeDisplayRequirements,
  matchesDeviceCriteria,
  type DeviceMatcher,
} from "../utils/deviceMatcher";
import { logger } from "../utils/logger";
import { AndroidAvdIdentityConflictError } from "./AndroidAvdIdentityConflictError";
import { type DisplayInventoryProvider } from "./DisplayInventoryProvider";
import { assertAndroidAvdIdentityResolved } from "./androidBootIdentity";
import { enrichBootedDevice } from "./bootedDeviceEnrichment";
import { type DeviceBootRecovery } from "./deviceBootRecovery";
import type { DeviceCreationGate } from "./deviceCreationGate";
import type {
  DeviceProvisioner,
  ProvisionedDevice,
  ProvisioningCreateIdentity,
} from "./deviceProvisioning";
import { type BootedDeviceDiscoveryOptions, type PlatformDeviceManager } from "./deviceUtils";
import type { StableVirtualDeviceIdentity } from "./virtualDeviceLifecycleCoordinator";
import {
  getVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";

/** Bound on the iOS post-lease "did a sibling already boot this simulator" re-check (#9920). */
export const IOS_POST_LEASE_RECHECK_TIMEOUT_MS = 5_000;

/**
 * Whether a request that names its device by `deviceId` also carries spec fields that device must
 * satisfy. `name` is a spec field like any other (#11648); an exact name (`matchExactName`) paired
 * with a deviceId is an identity pair with its own typed mismatch checks, so it stays out.
 */
export function hasExplicitSpecConstraints(request: DeviceBootRequest): boolean {
  return (
    (request.name !== undefined && request.matchExactName !== true) ||
    request.minOsVersion !== undefined ||
    request.maxOsVersion !== undefined ||
    request.formFactor !== undefined ||
    request.requires !== undefined ||
    request.screenSize !== undefined
  );
}

export function assertBootedMatchesImage(device: BootedDevice, image: DeviceInfo): void {
  if (image.platform !== "android") {
    return;
  }
  if (device.platform !== image.platform || device.name !== image.name) {
    throw new ActionableError(
      `target_identity_mismatch: Configured ${image.platform} image '${image.name}' ` +
        `(${image.deviceId ?? "no runtime ID"}) resolved to '${device.name}' (${device.deviceId}). ` +
        "Retry after device discovery refreshes.",
    );
  }
}

/**
 * A `name` constraint on an emulator whose AVD-name probe went unanswered cannot be judged: the
 * placeholder name proves neither a match nor a mismatch, so the request is retryable rather than
 * refused as unsatisfied (#11648).
 */
export function assertRequestedNameVerifiable(
  request: DeviceBootRequest,
  running: BootedDevice,
): void {
  if (request.name !== undefined && request.matchExactName !== true) {
    assertAndroidAvdIdentityResolved([running], request.name);
  }
}

export function assertExactRunningDiscovery(
  request: DeviceBootRequest,
  devices: readonly BootedDevice[],
): void {
  if (request.matchExactName && request.name && request.platform === "android") {
    assertAndroidAvdIdentityResolved(devices, request.name);
  }
}

export function assertExactRunningName(request: DeviceBootRequest, device: BootedDevice): void {
  if (request.matchExactName && request.name && device.name !== request.name) {
    throw new ActionableError(
      `target_identity_mismatch: Requested ${request.platform} device '${request.name}' ` +
        `resolved to '${device.name}' (${device.deviceId}).`,
    );
  }
}

/**
 * Resolves an exact Android AVD name only when it maps to one live ADB serial.
 * Repeated discovery rows for the same serial do not make the identity ambiguous.
 */
export function findUniqueBootedAndroidDeviceByName(
  devices: readonly BootedDevice[],
  avdName: string,
): BootedDevice | undefined {
  const matchesBySerial = new Map(
    devices
      .filter(
        (device) =>
          !device.foreignOwned &&
          device.platform === "android" &&
          device.name === avdName &&
          isAndroidEmulatorSerial(device.deviceId),
      )
      .map((device): [string, BootedDevice] => [device.deviceId, device]),
  );
  const matches = [...matchesBySerial.values()];
  if (matches.length > 1) {
    throw new AndroidAvdIdentityConflictError(avdName, [...matchesBySerial.keys()].toSorted());
  }
  return matches[0];
}

// DeviceBootService instances are per request, while a duplicate Android
// start is coordinated through the shared lifecycle coordinator. Keep the
// ownership marker at that process-local boundary until readiness settles.
export const inFlightAndroidColdBoots = new WeakMap<
  VirtualDeviceLifecycleCoordinator,
  Map<string, number>
>();

export interface InFlightAndroidColdBootReader {
  /** AVD names with at least one in-flight (claimed, not yet released) Android cold boot. */
  listInFlightAndroidColdBootAvdNames(): readonly string[];
}

export function getInFlightAndroidColdBootReader(
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator = getVirtualDeviceLifecycleCoordinator(),
): InFlightAndroidColdBootReader {
  return {
    listInFlightAndroidColdBootAvdNames: () => [
      ...(inFlightAndroidColdBoots.get(lifecycleCoordinator)?.keys() ?? []),
    ],
  };
}

export function notifyAndroidColdBootTrackingChanged(
  listener: DeviceBootServiceDependencies["onAndroidColdBootTrackingChanged"],
  avdName: string,
  phase: "claimed" | "released",
): void {
  try {
    listener?.(avdName, phase);
  } catch (error) {
    // Resource notification is advisory; listener failure must not fail the boot.
    logger.warn(
      `[DeviceBootService] Android cold-boot tracking listener failed: ${errorMessage(error)}`,
      error,
    );
  }
}

export function trackInFlightAndroidColdBoot(
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator,
  avdName: string,
  listener?: DeviceBootServiceDependencies["onAndroidColdBootTrackingChanged"],
): () => void {
  const boots = inFlightAndroidColdBoots.get(lifecycleCoordinator) ?? new Map<string, number>();
  inFlightAndroidColdBoots.set(lifecycleCoordinator, boots);
  const priorCount = boots.get(avdName) ?? 0;
  boots.set(avdName, priorCount + 1);
  if (priorCount === 0) {
    notifyAndroidColdBootTrackingChanged(listener, avdName, "claimed");
  }
  return () => {
    const remaining = (boots.get(avdName) ?? 1) - 1;
    if (remaining > 0) {
      boots.set(avdName, remaining);
      return;
    }
    boots.delete(avdName);
    if (boots.size === 0) {
      inFlightAndroidColdBoots.delete(lifecycleCoordinator);
    }
    notifyAndroidColdBootTrackingChanged(listener, avdName, "released");
  };
}

export function hasInFlightAndroidColdBoot(
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator,
  avdName: string,
): boolean {
  return (inFlightAndroidColdBoots.get(lifecycleCoordinator)?.get(avdName) ?? 0) > 0;
}

export function trackInFlightAndroidColdBootIfNeeded(
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator,
  image: DeviceInfo,
  listener?: DeviceBootServiceDependencies["onAndroidColdBootTrackingChanged"],
): (() => void) | undefined {
  return image.platform === "android"
    ? trackInFlightAndroidColdBoot(lifecycleCoordinator, image.name, listener)
    : undefined;
}

/** Whether a boot re-checks for an already-running device after its lifecycle lease settles. */
export type AdoptAfterLease = "always" | "if-queued" | "never";

export function findBootedDeviceMatchingImage(
  image: DeviceInfo,
  booted: readonly BootedDevice[],
): BootedDevice | undefined {
  if (image.platform === "android") {
    const sameName = findUniqueBootedAndroidDeviceByName(booted, image.name);
    return sameName;
  }
  return image.deviceId ? booted.find((device) => device.deviceId === image.deviceId) : undefined;
}

export function findEligibleExactBootedDevice(
  platform: Platform,
  devices: BootedDevice[],
  name: string,
  criteria: DeviceMatchCriteria,
): BootedDevice | null {
  const exact =
    platform === "android"
      ? findUniqueBootedAndroidDeviceByName(devices, name)
      : devices.find((candidate) => candidate.name === name);
  return exact && matchesDeviceCriteria(exact, criteria) ? exact : null;
}

/** Inputs which affect device discovery, creation, and readiness, but not MCP sessions or automation setup. */
export interface DeviceBootRequest {
  cameraPosterPath?: string;
  operationName?: string;
  platform: "android" | "ios";
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  formFactor?: FormFactor;
  requires?: DeviceMatchCriteria["requires"];
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
  /** Absolute deadline shared with higher-level automation readiness. */
  totalDeadlineMs?: number;
  signal?: AbortSignal;
  createIfMissing?: boolean;
  /**
   * The caller just created this device (a fresh provision), so its first boot
   * is a genuine cold boot. Opts the Android readiness wait into bounded
   * ADB-offline recovery instead of silently waiting out the whole budget
   * (issue #7054).
   */
  freshProvision?: boolean;
  /** Internal CI policy: preserve OS bounds for provisioning while matching its exact owned name across runtime fallback. */
  matchNamedDeviceIgnoringOsVersion?: boolean;
  /** Internal identity policy: select a named runtime only when its name is an exact match. */
  matchExactName?: boolean;
  /**
   * Recovery snapshots keep preserved Android AVDs out of a concurrent startup match; managed
   * bindings keep their AVDs out of generic starts (#11174).
   */
  excludeDeviceNames?: ReadonlySet<string>;
  /**
   * Recovery snapshots keep preserved Android serials out of a concurrent startup match; managed
   * bindings keep their simulator UDIDs out of generic starts (#11174). Matched against both booted
   * devices and images.
   */
  excludeDeviceIds?: ReadonlySet<string>;
  /**
   * Booted devices a selector match takes only when no other booted device satisfies the spec:
   * the ones another session holds (#11648). They stay candidates, so a spec only held devices
   * satisfy keeps its typed ownership refusal instead of booting around the holder. An exact
   * target (`deviceId`, `matchExactName`) is an identity, not a choice, and ignores this.
   */
  deferDeviceIds?: ReadonlySet<string>;
  /** Non-mutating acceptance control for deterministic discovery-order coverage. */
  presentationOrder?: BootedDeviceDiscoveryOptions["presentationOrder"];
}

export interface DeviceBootProgress {
  report(current: number, total: number, message: string): Promise<void>;
}

export interface DeviceBootResult {
  device: BootedDevice;
  source: "booted" | "cold-boot";
  runningBeforeCall?: true;
  sourceImage?: DeviceInfo;
  processHandle?: ChildProcess | null;
  processId?: number;
  provisioned: boolean;
}

export interface DeviceBootServiceDependencies {
  invalidateAndroidDeviceList?: () => void;
  deviceManager: PlatformDeviceManager;
  deviceMatcher: DeviceMatcher;
  displayInventory?: DisplayInventoryProvider;
  deviceCreationGate: DeviceCreationGate;
  deviceProvisioner: DeviceProvisioner;
  matchingStrategy: MatchingStrategy;
  /** Defaults to no recovery so normal product and MCP boot never erases devices. */
  bootRecovery?: DeviceBootRecovery;
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  /** Bind a selector reservation to canonical identity before mutating the device. */
  onIdentityResolved?: (identity: StableVirtualDeviceIdentity) => Promise<void>;
  lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator;
  /** Fired synchronously, fire-and-forget on the 0->1 claim and 1->0 release transitions. */
  onAndroidColdBootTrackingChanged?: (avdName: string, phase: "claimed" | "released") => void;
  /** Existing lease held by a caller through later session/readiness work. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
  /**
   * Called with the exit promise of an owned emulator that survived SIGTERM and
   * SIGKILL, so an injected lease's owner can hold it until the process is gone
   * (#9901). A lease this service reserves itself is held automatically.
   */
  retainLeaseUntil?: (settlement: Promise<void>) => void;
  /**
   * Set by a long-lived owner (the daemon): once the request is cancelled or out of budget, the
   * emulator's termination may carry on in the background while the lease stays held (#9920).
   * Left unset by a one-shot process (`--boot-device`) that exits as soon as `boot` returns,
   * which would take the SIGKILL escalation's timer down with it: there `boot` waits in full.
   */
  cleanupMayOutliveRequest?: boolean;
  /** Liveness probe for an emulator that survived SIGKILL; injected so tests never signal a real pid. */
  isProcessRunning?: (pid: number) => boolean;
  /** Opts an injected daemon lease into post-bind re-checks; deviceTools' reservation races tolerate shared cold boots. */
  allowExternalLeaseAdoptionRecheck?: boolean;
  /**
   * Removes a device this boot created (createIfMissing) when binding or booting
   * it then fails, so it is not orphaned (#11100). The original failure is still
   * thrown; a rollback failure is the callee's to report.
   *
   * When the create itself was cancelled or timed out, `device` carries only the
   * identity the create claimed (no iOS UDID) and `pendingCreation` settles once
   * the platform create has; the callee resolves the exact device after it
   * (#11155).
   */
  rollbackCreatedDevice?: (
    device: DeviceInfo,
    failure: unknown,
    options?: { pendingCreation?: Promise<unknown> },
  ) => Promise<void>;
  /**
   * Read-only boot capacity check run before creating a device (createIfMissing), so at the
   * limit the request is refused with `capacity_exhausted` instead of creating, being refused
   * at boot and deleting (#11236). Defaults to the process-wide admission gates.
   */
  checkBootCapacity?: (platform: Platform, signal?: AbortSignal) => Promise<void>;
}

export function noMatchingDeviceError(
  request: DeviceBootRequest,
  criteria: DeviceMatchCriteria,
  images: DeviceInfo[],
  describedCandidates: Parameters<typeof describeDisplayRequirements>[1],
): ActionableError {
  return new ActionableError(
    `No ${request.platform} device matching criteria found. ` +
      `${request.minOsVersion ? `minOsVersion>=${request.minOsVersion} ` : ""}` +
      `${request.maxOsVersion ? `maxOsVersion<=${request.maxOsVersion} ` : ""}` +
      `${request.name ? `name=${request.name} ` : ""}` +
      `${describeDisplayRequirements(criteria, describedCandidates)} ` +
      `Available images: ${images.map((device) => `${device.name}${device.osVersion ? ` (v${device.osVersion})` : ""}`).join(", ") || "none"}.`,
  );
}

export function createdImageFor(
  provisioned: ProvisionedDevice | ProvisioningCreateIdentity,
  request: DeviceBootRequest,
): DeviceInfo {
  return {
    name: provisioned.name,
    platform: provisioned.platform,
    deviceId: "deviceId" in provisioned ? provisioned.deviceId : undefined,
    isRunning: false,
    formFactor: request.formFactor,
    runtimeId: provisioned.runtimeId,
    runtime: provisioned.runtime,
    deviceType: provisioned.deviceType,
  } as DeviceInfo;
}

export function enrichBootedDevicesFromImages(
  booted: BootedDevice[],
  images: DeviceInfo[],
): BootedDevice[] {
  const imagesById = new Map(
    images.filter((image) => image.deviceId).map((image) => [image.deviceId!, image]),
  );
  const imagesByName = new Map(images.map((image) => [image.name, image]));
  return booted.map((device) => {
    const canMatchAndroidByName =
      device.platform === "android" && isAndroidEmulatorSerial(device.deviceId);
    const image =
      (device.deviceId ? imagesById.get(device.deviceId) : undefined) ??
      (canMatchAndroidByName ? imagesByName.get(device.name) : undefined);
    return image?.platform === device.platform ? enrichBootedDevice(device, image) : device;
  });
}

/** Whether a startup match must skip this image: its name or its device id is excluded. */
export function isExcludedImage(
  image: DeviceInfo,
  excludedNames: ReadonlySet<string> | undefined,
  excludedIds: ReadonlySet<string> | undefined,
): boolean {
  return (
    excludedNames?.has(image.name) === true ||
    (image.deviceId !== undefined && excludedIds?.has(image.deviceId) === true)
  );
}
