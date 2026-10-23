import { isErrored, holderOf } from "../deviceBinding";
import { type BindDeviceRequest } from "../explicitDeviceBind";
import { holderReleaseRemainingMs } from "../holderReleaseRemaining";
import { type AcquisitionReceipt } from "../acquisitionReceipt";
import { TransitionalAdbBindWait } from "../transitionalAdbBindWait";
import { isAnonymousAcquisitionSession, type Session } from "../sessionManager";
import { ActionableError } from "../../models";
import { heldDeviceBindRefusal } from "../inputDeviceOwnership";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { didSourceSucceedForDevice } from "../../utils/discoverySource";
import { getAbortSignal, throwIfRequestAborted } from "../../utils/AbortContext";
import { type AutolockClient } from "../deviceAutolockManager";
import type { BootedDevice } from "../../models";
import type { PooledDevice } from "../devicePoolTypes";
import {
  ALLOCATION_SNAPSHOT_STALE_RETRIES,
  ANDROID_OFFLINE_PROBE_TIMEOUT_MS,
  TargetDeviceDiscoverySnapshot,
  TargetDeviceDiscoveryOptions,
  TargetDeviceValidationOptions,
} from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface TargetDiscoveryOperations {
  pickUpRunningDevice(device: BootedDevice, signal?: AbortSignal): Promise<void>;
  /**
   * Bind a known device to a session without running the pool's idle-device
   * selection. If the device is already bound to a live session, reuse that
   * session so repeated startDevice calls stay idempotent.
   */
  bindOrReuseDeviceSession(request: BindDeviceRequest): Promise<string>;
  claimExplicitlyBoundDevice(
    sessionId: string,
    deviceId: string,
    heldBefore: string | null,
    createdSession?: Session,
  ): Promise<void>;
  /**
   * Take back an acquisition whose result never reached its caller: the request was cancelled or
   * timed out while the bind was still finishing (typically publishing its cross-daemon claim), so
   * no client holds the session id. Only the session the acquisition minted is released, for good,
   * and only while it still holds the device; the claim goes with the device. A session that was
   * reused, has been replaced, or was already released is left alone (#11565). A session the call
   * moved from another device is moved back there, and one minted under an id its client chose is
   * rolled back without retiring that id, which the client will name again (#11593).
   */
  releaseUndeliveredAcquisition(receipt: AcquisitionReceipt): Promise<void>;
  hasForeignTargetDeviceHolder(
    device: PooledDevice | undefined,
    sessionId: string | undefined,
    readinessReservationOwners: ReadonlySet<symbol> | undefined,
  ): boolean;
  withTargetDeviceDiscovery({
    deviceId,
    sessionId,
    readinessReservationOwners,
    sourceImage,
    isLaunchProcessAlive,
    expectedIdentity,
    unavailableMessage,
    platform,
    operation,
  }: TargetDeviceDiscoveryOptions): Promise<string>;
  validateOrReloadIdlePooledDevice(
    options: TargetDeviceValidationOptions,
  ): Promise<PooledDevice | undefined>;
  /** A read-only retry hint when this holder is already on its way out. */
  holderReleaseRemainingMs(holderSessionId: string): number | undefined;
  assertCallerOwnsDeviceSession(
    caller: AutolockClient | undefined,
    session: Session,
    device: PooledDevice,
    spawnedDevice?: boolean,
  ): boolean;
}
type TargetDiscoveryState = Pick<
  DevicePoolState,
  | "explicitDeviceBind"
  | "timer"
  | "deviceManager"
  | "devices"
  | "refreshCoordinator"
  | "intentionalShutdowns"
  | "shutdownReservationCoordinator"
  | "idleDeviceReaper"
  | "recoveryCoordinator"
  | "assignmentMutex"
  | "runtimeIdentity"
  | "missingDeviceLiveness"
  | "ownerDisconnectRelease"
  | "sessionManager"
>;
export type TargetDiscoveryCallbacks = Pick<
  DevicePoolOperations,
  | "hasReadinessNameReservation"
  | "isReservedForOtherRehydration"
  | "takeFreshPresenceDiscovery"
  | "assertTargetDeviceLiveness"
  | "addDevice"
  | "ensurePooledDevicePresentForUse"
  | "isPooledEntryCurrent"
  | "assertIdleDeviceAssignable"
  | "getAssignedDevices"
  | "hasAcquiredDeviceSession"
  | "isSessionAssignmentCurrent"
>;

/** Target Discovery responsibilities of DevicePool. */
export class DevicePoolTargetDiscovery {
  constructor(
    private readonly state: TargetDiscoveryState,
    private readonly callbacks: TargetDiscoveryCallbacks,
  ) {}
  /** Share the insertion fence with exact-device discovery, including absent-slot shutdowns. */
  private insertionWasFenced(
    deviceId: string,
    removalFence: { wasRemoved(): boolean },
    shutdownMarker: number | undefined,
    shutdownReserved: boolean,
  ): boolean {
    return (
      removalFence.wasRemoved() ||
      shutdownReserved ||
      this.state.shutdownReservationCoordinator.isDeviceUnderShutdown(deviceId) ||
      shutdownMarker !== this.state.intentionalShutdowns.get(deviceId) ||
      shutdownMarker !== undefined
    );
  }

  async pickUpRunningDevice(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    const deviceId = device.deviceId;
    if (this.state.devices.has(deviceId)) {
      return;
    }
    const removalFence = this.state.refreshCoordinator.captureDeviceRemovalFence(deviceId);
    const shutdownMarker = this.state.intentionalShutdowns.get(deviceId);
    const shutdownReserved =
      this.state.shutdownReservationCoordinator.isDeviceUnderShutdown(deviceId);
    const shutdownMessage = `Device ${deviceId} is being shut down; retry after shutdown completes.`;
    const unavailableMessage = `Device ${deviceId} is no longer running; call startDevice for it.`;
    const pickupSignal = signal ?? getAbortSignal();
    try {
      if (shutdownMarker !== undefined || shutdownReserved) {
        throw new ActionableError(shutdownMessage);
      }
      const discovery = await raceWithDeadline(
        () => this.callbacks.takeFreshPresenceDiscovery(device.platform),
        { timer: this.state.timer, signal: pickupSignal, label: "Running device pickup" },
      );
      if (device.platform === "ios") {
        this.callbacks.assertTargetDeviceLiveness({
          device: { id: deviceId, platform: device.platform },
          unavailableMessage,
          snapshot: {
            capturedEntry: undefined,
            bootedDevices: discovery.devices,
            iosLiveness: await this.state.idleDeviceReaper.getIosLivenessSnapshot({ discovery }),
          },
        });
      }
      const fresh = discovery.devices.find((candidate) => candidate.deviceId === deviceId);
      if (!fresh) {
        throw new ActionableError(unavailableMessage);
      }
      const evidence = this.state.runtimeIdentity.identityEvidenceForBootedDevice(fresh);
      await this.state.assignmentMutex.runExclusive(async () => {
        if (this.state.devices.has(deviceId)) {
          return;
        }
        pickupSignal?.throwIfAborted();
        if (this.insertionWasFenced(deviceId, removalFence, shutdownMarker, shutdownReserved)) {
          throw new ActionableError(shutdownMessage);
        }
        await this.callbacks.addDevice(fresh, undefined, true, evidence);
      });
    } finally {
      removalFence.release();
    }
  }

  /**
   * Bind a known device to a session without running the pool's idle-device
   * selection. If the device is already bound to a live session, reuse that
   * session so repeated startDevice calls stay idempotent.
   */
  bindOrReuseDeviceSession(request: BindDeviceRequest): Promise<string> {
    // The ambient signal is read once here, at the pool entry point; the bind takes it explicitly.
    return this.state.explicitDeviceBind.bindOrReuseDeviceSession({
      ...request,
      signal: request.signal ?? getAbortSignal(),
    });
  }

  /**
   * Publish this daemon's claim on an explicitly bound device. Another daemon can claim it between
   * the pre-bind check and here; then a fresh bind is rolled back and refused like the check
   * (#10980). A device this daemon already held keeps its session.
   *
   * The publish is awaited after the session committed. When it throws, `createdSession` (the
   * session this very acquisition minted, absent for a reused or rebound one) is released again
   * rather than left holding the device under a call that failed (#11565).
   */
  claimExplicitlyBoundDevice(
    sessionId: string,
    deviceId: string,
    heldBefore: string | null,
    createdSession?: Session,
  ): Promise<void> {
    return this.state.explicitDeviceBind.claimExplicitlyBoundDevice(
      sessionId,
      deviceId,
      heldBefore,
      createdSession,
    );
  }

  /**
   * Take back an acquisition whose result never reached its caller: the request was cancelled or
   * timed out while the bind was still finishing (typically publishing its cross-daemon claim), so
   * no client holds the session id. Only the session the acquisition minted is released, for good,
   * and only while it still holds the device; the claim goes with the device. A session that was
   * reused, has been replaced, or was already released is left alone (#11565). A session the call
   * moved from another device is moved back there, and one minted under an id its client chose is
   * rolled back without retiring that id, which the client will name again (#11593).
   */
  releaseUndeliveredAcquisition(receipt: AcquisitionReceipt): Promise<void> {
    return this.state.explicitDeviceBind.releaseUndeliveredAcquisition(receipt);
  }

  /** Leave foreign ownership refusals to the operation instead of waiting on transport. */
  hasForeignTargetDeviceHolder(
    device: PooledDevice | undefined,
    sessionId: string | undefined,
    readinessReservationOwners: ReadonlySet<symbol> | undefined,
  ): boolean {
    return (
      device !== undefined &&
      ((holderOf(device) !== null && holderOf(device) !== sessionId) ||
        this.callbacks.hasReadinessNameReservation(device, readinessReservationOwners) ||
        this.callbacks.isReservedForOtherRehydration(device, sessionId))
    );
  }

  /** Snapshot first, then serialize assertions and claim; replacements retry unlocked. */
  async withTargetDeviceDiscovery({
    deviceId,
    sessionId,
    readinessReservationOwners,
    sourceImage,
    isLaunchProcessAlive,
    expectedIdentity,
    unavailableMessage,
    platform,
    operation,
  }: TargetDeviceDiscoveryOptions): Promise<string> {
    let staleRetries = 0;
    let readyNotifiedEntry: PooledDevice | undefined;
    const transportWait = new TransitionalAdbBindWait(deviceId, {
      timer: this.state.timer,
      probe: this.state.deviceManager.getAndroidListedDeviceStates?.bind(this.state.deviceManager),
      probeTimeoutMs: ANDROID_OFFLINE_PROBE_TIMEOUT_MS,
      getSignal: getAbortSignal,
      isLaunchProcessAlive,
      hasResolvedRuntime:
        expectedIdentity?.platform === "android" && expectedIdentity.deviceId === deviceId,
    });
    while (true) {
      throwIfRequestAborted();
      const capturedEntry = this.state.devices.get(deviceId);
      const removalFence = this.state.refreshCoordinator.captureDeviceRemovalFence(deviceId);
      const shutdownMarker = this.state.intentionalShutdowns.get(deviceId);
      const shutdownReserved =
        this.state.shutdownReservationCoordinator.isDeviceUnderShutdown(deviceId);
      let result: string | undefined;
      try {
        const snapshot = await raceWithDeadline(
          async (): Promise<TargetDeviceDiscoverySnapshot> => {
            const targetPlatform = capturedEntry?.platform ?? platform;
            if (targetPlatform === "android") {
              const androidPresence = await this.callbacks.takeFreshPresenceDiscovery("android");
              return { capturedEntry, androidPresence, bootedDevices: androidPresence.devices };
            }
            if (capturedEntry) {
              return {
                capturedEntry,
                iosLiveness: await this.state.idleDeviceReaper.getIosLivenessSnapshot(),
              };
            }
            const discovery = await this.callbacks.takeFreshPresenceDiscovery("ios");
            return {
              capturedEntry,
              bootedDevices: discovery.devices,
              iosLiveness: await this.state.idleDeviceReaper.getIosLivenessSnapshot({ discovery }),
            };
          },
          { timer: this.state.timer, signal: getAbortSignal(), label: "Exact device discovery" },
        );
        const skipTransportWait = [
          shutdownReserved,
          shutdownMarker !== undefined,
          this.state.recoveryCoordinator.recoveringAndroidDeviceIds.has(deviceId),
          this.hasForeignTargetDeviceHolder(capturedEntry, sessionId, readinessReservationOwners),
        ].some(Boolean);
        if (
          !skipTransportWait &&
          snapshot.androidPresence &&
          didSourceSucceedForDevice(snapshot.androidPresence, "android", deviceId) &&
          !snapshot.androidPresence.devices.some((device) => device.deviceId === deviceId) &&
          (await transportWait.waitIfTransitional())
        ) {
          continue;
        }
        snapshot.readyNotifiedEntry = readyNotifiedEntry;
        result = await this.state.assignmentMutex.runExclusive(async () => {
          throwIfRequestAborted();
          if (this.state.devices.get(deviceId) !== capturedEntry) {
            return undefined;
          }
          if (capturedEntry) {
            return operation(snapshot);
          }
          // Undefined -> added -> retired -> undefined is also a changed incarnation.
          // Refuse before addDevice can clear a recorded intentional shutdown.
          if (this.insertionWasFenced(deviceId, removalFence, shutdownMarker, shutdownReserved)) {
            throw new ActionableError(unavailableMessage);
          }
          // A failed iOS source may return no target or a retained last-good
          // target. Either way, it cannot authorize a new pooled assignment.
          if (platform === "ios") {
            this.callbacks.assertTargetDeviceLiveness({
              device: { id: deviceId, platform },
              unavailableMessage,
              snapshot,
            });
          }
          const booted = snapshot.bootedDevices?.find((device) => device.deviceId === deviceId);
          if (booted) {
            const addition = this.callbacks.addDevice(
              booted,
              sourceImage,
              true,
              this.state.runtimeIdentity.identityEvidenceForBootedDevice(booted),
            );
            const addedEntry = this.state.devices.get(deviceId);
            await addition;
            readyNotifiedEntry = addedEntry;
            if (this.state.devices.get(deviceId) !== addedEntry) {
              return undefined;
            }
          }
          return operation(snapshot);
        });
      } finally {
        removalFence.release();
      }
      if (result !== undefined) {
        return result;
      }
      if (staleRetries++ >= ALLOCATION_SNAPSHOT_STALE_RETRIES) {
        throw new ActionableError(unavailableMessage);
      }
    }
  }

  async validateOrReloadIdlePooledDevice(
    options: TargetDeviceValidationOptions,
  ): Promise<PooledDevice | undefined> {
    const { device, expectedIdentity, unavailableMessage, snapshot } = options;
    const presence = snapshot.androidPresence;
    // Existing pooled targets retain on source failure. A just-installed target
    // cannot use a failed confirmation pass as identity evidence. Authoritative
    // absence also stops before the liveness helper's eviction/recovery branch.
    if (
      presence &&
      (didSourceSucceedForDevice(presence, device.platform, device.id)
        ? !presence.devices.some((booted) => booted.deviceId === device.id)
        : snapshot.readyNotifiedEntry !== undefined)
    ) {
      throw new ActionableError(unavailableMessage);
    }
    // iOS uses the per-source liveness snapshot; Android reconciles the supplied evidence.
    if (
      await this.callbacks.ensurePooledDevicePresentForUse(device, {
        deferRecovery: true,
        assignmentLockHeld: true,
        discovery: presence,
      })
    ) {
      if (!this.callbacks.isPooledEntryCurrent(device)) {
        return undefined;
      }
      this.callbacks.assertIdleDeviceAssignable(options);
      // A reusable serial's initial listing predates installation in the pool.
      // Confirm it with a fresh unlocked pass before handing out the entry.
      if (!snapshot.capturedEntry && this.state.missingDeviceLiveness.hasReusableSerial(device)) {
        return undefined;
      }
      return device;
    }
    const replacement = this.state.devices.get(device.id);
    if (!replacement || (replacement === device && isErrored(device))) {
      throw new ActionableError(unavailableMessage);
    }
    if (replacement.identityUnresolved === true) {
      throw new ActionableError(
        this.state.runtimeIdentity.describeUnresolvedPooledIdentity(
          replacement,
          "Refusing to assign device",
        ),
      );
    }
    this.state.runtimeIdentity.assertRuntimeIdentity(replacement, expectedIdentity);
    // Reconciliation's replacement cannot inherit the captured entry's evidence.
    // Retry outside the mutex before judging or claiming that incarnation.
    return undefined;
  }

  /** A read-only retry hint when this holder is already on its way out. */
  holderReleaseRemainingMs(holderSessionId: string): number | undefined {
    return holderReleaseRemainingMs({
      disconnectRemainingMs: this.state.ownerDisconnectRelease.remainingMs(holderSessionId),
      ownerLease: this.state.sessionManager.getSessionLeaseState(holderSessionId),
      releasing: this.state.sessionManager.getReleasingSession(holderSessionId) !== null,
      ownerLeaseAwaitsReap: this.state.sessionManager.ownerLeaseAwaitsReap(holderSessionId),
    });
  }

  /**
   * Assert the caller may act on `session` and return whether same-owner reuse was proven. An
   * identified MCP connection must have acquired it; a one-shot `--cli` caller may act only on a
   * session another anonymous acquisition created, and is then its owner unless this acquisition
   * spawned the device (#11096, #11138, #11153); a
   * caller with no identity is left to the anonymous reuse check.
   */
  assertCallerOwnsDeviceSession(
    caller: AutolockClient | undefined,
    session: Session,
    device: PooledDevice,
    spawnedDevice = false,
  ): boolean {
    if (caller?.oneShotCli === true) {
      if (!isAnonymousAcquisitionSession(session)) {
        throw heldDeviceBindRefusal(
          this.callbacks,
          device.id,
          session.sessionId,
          undefined,
          "another",
        );
      }
      // Anonymous acquisitions share one owner, so a one-shot CLI caller reusing one is its
      // confirmed owner. Returning false sent an acquisition that resolved a source image (an AVD
      // name, or a booted AVD's serial) into the freshly-started-device guard (#11138).
      // An acquisition that spawned the emulator itself is not: a different one-shot's anonymous
      // bind of the same serial mid-boot must be refused, not silently shared (#11153).
      return !spawnedDevice;
    }
    const mcpSessionId = caller?.mcpSessionId;
    if (mcpSessionId === undefined) {
      return false;
    }
    if (
      !this.callbacks.hasAcquiredDeviceSession(mcpSessionId, session.sessionId) ||
      !this.callbacks.isSessionAssignmentCurrent(device, session) ||
      !this.state.sessionManager.isAdmittedForAutomation(session)
    ) {
      throw heldDeviceBindRefusal(
        this.callbacks,
        device.id,
        session.sessionId,
        undefined,
        "another",
      );
    }
    return true;
  }
}

export function connectTargetDiscovery(
  part: () => DevicePoolTargetDiscovery,
  seams: Pick<
    DevicePoolOperations,
    "bindOrReuseDeviceSession" | "releaseUndeliveredAcquisition" | "holderReleaseRemainingMs"
  >,
): TargetDiscoveryOperations {
  return {
    pickUpRunningDevice: (...args) => part().pickUpRunningDevice(...args),
    bindOrReuseDeviceSession: (...args) => seams.bindOrReuseDeviceSession(...args),
    claimExplicitlyBoundDevice: (...args) => part().claimExplicitlyBoundDevice(...args),
    releaseUndeliveredAcquisition: (...args) => seams.releaseUndeliveredAcquisition(...args),
    hasForeignTargetDeviceHolder: (...args) => part().hasForeignTargetDeviceHolder(...args),
    withTargetDeviceDiscovery: (...args) => part().withTargetDeviceDiscovery(...args),
    validateOrReloadIdlePooledDevice: (...args) => part().validateOrReloadIdlePooledDevice(...args),
    holderReleaseRemainingMs: (...args) => seams.holderReleaseRemainingMs(...args),
    assertCallerOwnsDeviceSession: (...args) => part().assertCallerOwnsDeviceSession(...args),
  };
}
