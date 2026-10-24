import {} from "../deviceBinding";
import { type AndroidTransportRouting } from "../../utils/androidSerial";
import { logger } from "../../utils/logger";
import { BootedDevice, Platform } from "../../models";
import { BINDING_INPUT_SNAPSHOT_MAX_AGE_MS } from "../inputDeviceOwnership";
import { type BootedDeviceDiscovery } from "../../devices/deviceUtils";
import { BootedDeviceDiscoveryIncompleteError } from "../../devices/deviceBootService";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { didSourceSucceedForDevice } from "../../utils/discoverySource";
import { getAbortSignal, throwIfRequestAborted } from "../../utils/AbortContext";
import type { MutableMetadataSource, PooledDevice } from "../devicePoolTypes";
import { ANDROID_OFFLINE_PROBE_TIMEOUT_MS, DiscoveryReconcileOptions } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface DiscoveryOperations {
  foldObservationIntoPooledEntry(
    pooled: PooledDevice,
    device: BootedDevice,
    metadataSource: MutableMetadataSource,
  ): Promise<boolean>;
  settlePooledRuntimeIdentity(
    deviceId: string,
    options?: {
      platform?: Platform;
      signal?: AbortSignal;
      totalDeadlineMs?: number;
    },
  ): Promise<"no-entry" | "matched" | "replaced" | "unsettled">;
  settleObservedRuntimeIdentities(devices: readonly BootedDevice[]): Promise<void>;
  settleObservedPooledRuntimeIdentity(
    observation: BootedDevice,
    signal?: AbortSignal | undefined,
    deadlineMs?: number,
  ): Promise<"no-entry" | "matched" | "replaced" | "unsettled">;
  reconcileDiscoveryObservation(
    devices: readonly BootedDevice[],
    source: string,
    options?: DiscoveryReconcileOptions,
  ): Promise<void>;
  /** Explicit routing state shared with adb clients; no process-global alias cache. */
  getAndroidTransportRouting(): AndroidTransportRouting;
  getAndroidTransportAliases(deviceId: string): string[];
  getAndroidTransportAvdName(deviceId: string): string | undefined;
  mapAndroidDiscovery(devices: readonly BootedDevice[]): BootedDevice[];
  /** Readiness sees live rows, so a surviving alias also takes over dispatch (#11133). */
  mapAndroidReadinessDiscovery(devices: readonly BootedDevice[]): BootedDevice[];
  resolveAndroidCanonicalId(deviceId: string): string;
  /**
   * Whether the pool would pool or assign this row: false for an Android transport whose identity
   * the fold could not prove, which may front a handset pooled (and held) under another id.
   */
  isAndroidTransportAssignable(device: BootedDevice): boolean;
  androidTransportMayAliasDevice(transport: BootedDevice, heldDeviceId?: string): boolean;
  androidBindingHold(heldDeviceIds: readonly string[]): Promise<
    | {
        entry: import(".././sessionBroker/registry/bindingRegistry").ManagedDeviceEntry | undefined;
      }
    | undefined
  >;
  isPooledAndroidEmulator(deviceId: string): boolean;
  needsAndroidTransportNormalization(devices: readonly BootedDevice[]): boolean;
  normalizeAndroidDiscovery(
    devices: readonly BootedDevice[],
    assignmentLockHeld?: boolean,
    isCurrent?: () => boolean,
    completeAndroidSnapshot?: boolean,
  ): Promise<BootedDevice[]>;
  describesPooledRuntime(expected: Pick<BootedDevice, "deviceId" | "name" | "platform">): boolean;
  /**
   * Whether `pooled` and a resolved runtime can be the same device. The single
   * predicate the pool's own matching and the public `startDevice` validator
   * (`validatePooledDeviceMapping`) share, so the two cannot drift (#10603).
   */
  matchesRuntimeIdentity(
    pooled: PooledDevice,
    expected: Pick<BootedDevice, "deviceId" | "name" | "platform">,
  ): boolean;
  isPooledIdentityUnresolved(deviceId: string): boolean;
  assertDeviceActionable(deviceId: string, purpose: string): void;
}
type DiscoveryState = Pick<
  DevicePoolState,
  | "runtimeIdentity"
  | "devices"
  | "timer"
  | "assignmentMutex"
  | "androidTransportAliases"
  | "bindingExclusion"
  | "androidAliasObservation"
  | "androidAliasRetirement"
  | "androidAliasAppliedObservation"
  | "androidAliasAppliedDevices"
>;
export type DiscoveryCallbacks = Pick<
  DevicePoolOperations,
  | "replacePooledDeviceForRuntimeIdentity"
  | "hasReusableSerial"
  | "takeFreshPresenceDiscovery"
  | "matchesRuntimeIdentity"
  | "managedRefFor"
  | "needsAndroidTransportNormalization"
  | "mapAndroidDiscovery"
>;

/** Discovery responsibilities of DevicePool. */
export class DevicePoolDiscovery {
  constructor(
    private readonly state: DiscoveryState,
    private readonly callbacks: DiscoveryCallbacks,
  ) {}
  /**
   * The per-entry body of the refresh sweep, which — unlike
   * {@link reconcileDiscoveryObservation} — owns pool membership and so installs
   * the replacement a disagreeing observation calls for. Returns whether the
   * runtime was REPLACED, which the sweep counts as an add.
   */
  async foldObservationIntoPooledEntry(
    pooled: PooledDevice,
    device: BootedDevice,
    metadataSource: MutableMetadataSource,
  ): Promise<boolean> {
    if (device.foreignOwned === true) {
      logger.debug(`[DevicePool] Skipping foreign refresh observation for ${device.deviceId}`);
      return false;
    }
    let entry: PooledDevice | undefined = pooled;
    let runtimeReplaced = false;
    let replacementDeferred = false;
    // A newer funnel observation may have confirmed this entry while the refresh was in flight.
    // Check before replacement, since eviction cannot be undone by later identity reconciliation.
    if (this.state.runtimeIdentity.comparePooledIdentityEvidence(pooled, device) === "stale") {
      return false;
    }
    if (!this.state.runtimeIdentity.matchesRuntimeIdentity(pooled, device)) {
      runtimeReplaced = await this.callbacks.replacePooledDeviceForRuntimeIdentity(pooled, device);
      entry = this.state.devices.get(device.deviceId);
      replacementDeferred = !runtimeReplaced && entry === pooled;
    }
    if (!entry) {
      return runtimeReplaced;
    }
    entry.iosVersion = device.iosVersion;
    if (replacementDeferred) {
      // The entry the pool still holds is the one this observation DISAGREES
      // with, so neither its metadata nor its identity may be updated from it.
      await this.state.runtimeIdentity.quarantineDisagreeingPooledIdentity(
        entry,
        device,
        "and its replacement could not be installed yet",
      );
      return runtimeReplaced;
    }
    this.state.runtimeIdentity.applyMutableRuntimeMetadata(entry, device, metadataSource);
    await this.state.runtimeIdentity.reconcilePooledIdentityResolution(entry, device);
    return runtimeReplaced;
  }

  /** Fresh, single-serial membership settlement before a start claims its runtime. */
  async settlePooledRuntimeIdentity(
    deviceId: string,
    options: {
      platform?: Platform;
      signal?: AbortSignal;
      totalDeadlineMs?: number;
    } = {},
  ): Promise<"no-entry" | "matched" | "replaced" | "unsettled"> {
    const { signal = getAbortSignal() } = options;
    const assertNotAborted = () => {
      signal?.throwIfAborted();
      throwIfRequestAborted();
    };
    assertNotAborted();
    const pooled = this.state.devices.get(deviceId);
    if (!pooled) {
      return "no-entry";
    }
    if (!this.callbacks.hasReusableSerial(pooled)) {
      return "unsettled";
    }
    const platform = options.platform ?? pooled.platform;
    const deadlineMs = Math.min(
      options.totalDeadlineMs ?? Infinity,
      this.state.timer.now() + ANDROID_OFFLINE_PROBE_TIMEOUT_MS,
    );
    let discovery: BootedDeviceDiscovery;
    try {
      discovery = await raceWithDeadline(
        () => this.callbacks.takeFreshPresenceDiscovery(platform),
        {
          timer: this.state.timer,
          signal,
          timeoutMs: Math.max(0, deadlineMs - this.state.timer.now()),
          label: "Pooled runtime identity discovery",
          timeoutError: () => new BootedDeviceDiscoveryIncompleteError(platform, undefined),
        },
      );
    } catch (error) {
      assertNotAborted();
      logger.warn(`Pooled runtime identity discovery failed for ${deviceId}`, error);
      return "unsettled";
    }
    assertNotAborted();
    if (!didSourceSucceedForDevice(discovery, platform, deviceId)) {
      return "unsettled";
    }
    const observation = discovery.devices.find((device) => device.deviceId === deviceId);
    if (!observation) {
      return "unsettled";
    }
    return raceWithDeadline(
      () => this.settleObservedPooledRuntimeIdentity(observation, signal, deadlineMs),
      {
        timer: this.state.timer,
        signal,
        timeoutMs: Math.max(0, deadlineMs - this.state.timer.now()),
        label: "Pooled runtime identity settlement",
        timeoutError: () => new BootedDeviceDiscoveryIncompleteError(platform, undefined),
      },
    );
  }

  /** Monitor-only membership pass over evidence already folded through FUNNEL 1. */
  async settleObservedRuntimeIdentities(devices: readonly BootedDevice[]): Promise<void> {
    for (const observation of devices) {
      const pooled = this.state.devices.get(observation.deviceId);
      if (
        observation.platform === "android" &&
        pooled &&
        this.callbacks.hasReusableSerial(pooled) &&
        !this.state.runtimeIdentity.hasUnresolvedEmulatorName(observation) &&
        !this.callbacks.matchesRuntimeIdentity(pooled, observation)
      ) {
        await this.settleObservedPooledRuntimeIdentity(observation);
      }
    }
  }

  settleObservedPooledRuntimeIdentity(
    observation: BootedDevice,
    signal = getAbortSignal(),
    deadlineMs = Infinity,
  ): Promise<"no-entry" | "matched" | "replaced" | "unsettled"> {
    return this.state.assignmentMutex.runExclusive(async () => {
      signal?.throwIfAborted();
      throwIfRequestAborted();
      const current = this.state.devices.get(observation.deviceId);
      if (!current) {
        return "no-entry";
      }
      if (
        !this.callbacks.hasReusableSerial(current) ||
        this.state.timer.now() >= deadlineMs ||
        this.state.runtimeIdentity.hasUnresolvedEmulatorName(observation) ||
        this.state.runtimeIdentity.comparePooledIdentityEvidence(current, observation) === "stale"
      ) {
        return "unsettled";
      }
      if (await this.foldObservationIntoPooledEntry(current, observation, "refresh")) {
        return "replaced";
      }
      const settled = this.state.devices.get(observation.deviceId);
      return !settled
        ? "no-entry"
        : this.callbacks.matchesRuntimeIdentity(settled, observation) && !settled.identityUnresolved
          ? "matched"
          : "unsettled";
    });
  }

  async reconcileDiscoveryObservation(
    devices: readonly BootedDevice[],
    source: string,
    options: DiscoveryReconcileOptions = {},
  ): Promise<void> {
    const { settleMembership, ...identityOptions } = options;
    // The one ambient read for this entry point (#11817): the identity tracker takes the signal explicitly.
    const signals = [options.signal, getAbortSignal()].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    await this.state.runtimeIdentity.reconcileDiscoveryObservation(devices, source, {
      ...identityOptions,
      signal,
    });
    if (settleMembership === true && !signal?.aborted) {
      await this.settleObservedRuntimeIdentities(devices);
    }
  }

  /** Explicit routing state shared with adb clients; no process-global alias cache. */
  getAndroidTransportRouting(): AndroidTransportRouting {
    return this.state.androidTransportAliases;
  }

  getAndroidTransportAliases(deviceId: string): string[] {
    return this.state.androidTransportAliases.aliases(deviceId);
  }

  getAndroidTransportAvdName(deviceId: string): string | undefined {
    return this.state.androidTransportAliases.avdName(deviceId);
  }

  mapAndroidDiscovery(devices: readonly BootedDevice[]): BootedDevice[] {
    return this.state.androidTransportAliases.mapDiscovery(devices);
  }

  /** Readiness sees live rows, so a surviving alias also takes over dispatch (#11133). */
  mapAndroidReadinessDiscovery(devices: readonly BootedDevice[]): BootedDevice[] {
    return this.state.androidTransportAliases.mapDiscovery(devices, true);
  }

  resolveAndroidCanonicalId(deviceId: string): string {
    return this.state.androidTransportAliases.canonicalFor(deviceId);
  }

  /**
   * Whether the pool would pool or assign this row: false for an Android transport whose identity
   * the fold could not prove, which may front a handset pooled (and held) under another id.
   */
  isAndroidTransportAssignable(device: BootedDevice): boolean {
    return this.state.androidTransportAliases.isAssignable(device);
  }

  androidTransportMayAliasDevice(transport: BootedDevice, heldDeviceId?: string): boolean {
    return this.state.androidTransportAliases.mayAliasDevice(transport, heldDeviceId);
  }

  /** One unknown Android hold for slots not represented by the frame's live session snapshot. */
  async androidBindingHold(heldDeviceIds: readonly string[]) {
    if (!this.state.bindingExclusion) {
      return undefined;
    }
    await this.state.bindingExclusion.refresh({
      maxAgeMs: BINDING_INPUT_SNAPSHOT_MAX_AGE_MS,
    });
    const represented = new Set(
      heldDeviceIds.flatMap((id) => this.callbacks.managedRefFor(id, "android").stableIds),
    );
    const stableId = [...this.state.bindingExclusion.stableIdsFor("android")].find(
      (id) => !represented.has(id),
    );
    return stableId === undefined
      ? undefined
      : {
          entry: this.state.bindingExclusion.holderOf({
            platform: "android",
            stableIds: [stableId],
          }),
        };
  }

  isPooledAndroidEmulator(deviceId: string): boolean {
    return (
      isAndroidEmulatorSerial(deviceId) ||
      this.state.androidTransportAliases.avdName(deviceId) !== undefined
    );
  }

  needsAndroidTransportNormalization(devices: readonly BootedDevice[]): boolean {
    return this.state.androidTransportAliases.needsNormalization(devices);
  }

  async normalizeAndroidDiscovery(
    devices: readonly BootedDevice[],
    assignmentLockHeld = false,
    isCurrent: () => boolean = () => true,
    completeAndroidSnapshot = true,
  ): Promise<BootedDevice[]> {
    if (
      !this.callbacks.needsAndroidTransportNormalization(devices) ||
      (!completeAndroidSnapshot && devices.every((device) => device.platform !== "android"))
    ) {
      return [...devices];
    }
    const observation = ++this.state.androidAliasObservation;
    const retirement = this.state.androidAliasRetirement;
    const evidence = await this.state.androidTransportAliases.prepare(devices);
    const fold = () => {
      if (!isCurrent()) {
        return [];
      }
      if (observation < this.state.androidAliasAppliedObservation) {
        return [...this.state.androidAliasAppliedDevices];
      }
      if (retirement !== this.state.androidAliasRetirement) {
        return this.callbacks.mapAndroidDiscovery(devices);
      }
      this.state.androidAliasAppliedObservation = observation;
      const normalized = this.state.androidTransportAliases.fold(
        devices,
        evidence,
        new Set(this.state.devices.ids()),
        completeAndroidSnapshot,
      );
      this.state.androidAliasAppliedDevices = normalized;
      return normalized;
    };
    return assignmentLockHeld ? fold() : this.state.assignmentMutex.runExclusive(fold);
  }

  describesPooledRuntime(expected: Pick<BootedDevice, "deviceId" | "name" | "platform">): boolean {
    return this.state.runtimeIdentity.describesPooledRuntime(expected);
  }

  /**
   * Whether `pooled` and a resolved runtime can be the same device. The single
   * predicate the pool's own matching and the public `startDevice` validator
   * (`validatePooledDeviceMapping`) share, so the two cannot drift (#10603).
   */
  matchesRuntimeIdentity(
    pooled: PooledDevice,
    expected: Pick<BootedDevice, "deviceId" | "name" | "platform">,
  ): boolean {
    return this.state.runtimeIdentity.matchesRuntimeIdentity(pooled, expected);
  }

  isPooledIdentityUnresolved(deviceId: string): boolean {
    return this.state.runtimeIdentity.isPooledIdentityUnresolved(deviceId);
  }

  assertDeviceActionable(deviceId: string, purpose: string): void {
    this.state.runtimeIdentity.assertDeviceActionable(deviceId, purpose);
  }
}

export function connectDiscovery(
  part: () => DevicePoolDiscovery,
  seams: Pick<
    DevicePoolOperations,
    | "settlePooledRuntimeIdentity"
    | "reconcileDiscoveryObservation"
    | "getAndroidTransportRouting"
    | "getAndroidTransportAliases"
    | "getAndroidTransportAvdName"
    | "mapAndroidDiscovery"
    | "mapAndroidReadinessDiscovery"
    | "resolveAndroidCanonicalId"
    | "isAndroidTransportAssignable"
    | "androidTransportMayAliasDevice"
    | "androidBindingHold"
    | "needsAndroidTransportNormalization"
    | "normalizeAndroidDiscovery"
    | "describesPooledRuntime"
    | "matchesRuntimeIdentity"
    | "isPooledIdentityUnresolved"
    | "assertDeviceActionable"
  >,
): DiscoveryOperations {
  return {
    foldObservationIntoPooledEntry: (...args) => part().foldObservationIntoPooledEntry(...args),
    settlePooledRuntimeIdentity: (...args) => seams.settlePooledRuntimeIdentity(...args),
    settleObservedRuntimeIdentities: (...args) => part().settleObservedRuntimeIdentities(...args),
    settleObservedPooledRuntimeIdentity: (...args) =>
      part().settleObservedPooledRuntimeIdentity(...args),
    reconcileDiscoveryObservation: (...args) => seams.reconcileDiscoveryObservation(...args),
    getAndroidTransportRouting: (...args) => seams.getAndroidTransportRouting(...args),
    getAndroidTransportAliases: (...args) => seams.getAndroidTransportAliases(...args),
    getAndroidTransportAvdName: (...args) => seams.getAndroidTransportAvdName(...args),
    mapAndroidDiscovery: (...args) => seams.mapAndroidDiscovery(...args),
    mapAndroidReadinessDiscovery: (...args) => seams.mapAndroidReadinessDiscovery(...args),
    resolveAndroidCanonicalId: (...args) => seams.resolveAndroidCanonicalId(...args),
    isAndroidTransportAssignable: (...args) => seams.isAndroidTransportAssignable(...args),
    androidTransportMayAliasDevice: (...args) => seams.androidTransportMayAliasDevice(...args),
    androidBindingHold: (...args) => seams.androidBindingHold(...args),
    isPooledAndroidEmulator: (...args) => part().isPooledAndroidEmulator(...args),
    needsAndroidTransportNormalization: (...args) =>
      seams.needsAndroidTransportNormalization(...args),
    normalizeAndroidDiscovery: (...args) => seams.normalizeAndroidDiscovery(...args),
    describesPooledRuntime: (...args) => seams.describesPooledRuntime(...args),
    matchesRuntimeIdentity: (...args) => seams.matchesRuntimeIdentity(...args),
    isPooledIdentityUnresolved: (...args) => seams.isPooledIdentityUnresolved(...args),
    assertDeviceActionable: (...args) => seams.assertDeviceActionable(...args),
  };
}
