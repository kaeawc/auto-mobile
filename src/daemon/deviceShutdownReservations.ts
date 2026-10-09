import { Mutex } from "async-mutex";
import { ActionableError, type BootedDevice } from "../models";
import { throwIfRequestAborted } from "../utils/AbortContext";
import type { AutolockClient } from "./deviceAutolockManager";
import { INCARNATION_ANY } from "./deviceDisconnectHandler";
import type {
  PooledDevice,
  DeviceReadinessReservation,
  ShutdownIdentityReservation,
} from "./devicePool";
import type { Session } from "./sessionManager";

interface ReadinessReservationTarget {
  deviceId: string;
  incarnation: number;
}

export interface ShutdownDeviceReservation {
  device: PooledDevice;
  session?: Session;
  release: () => Promise<void>;
  releaseRecoveryRouteLease: () => void;
}

/** All mutable pool state is obtained when used, including after awaits. */
export interface DeviceShutdownReservationsPoolPort {
  getDevices(): Map<string, PooledDevice>;
  getAssignmentMutex(): Mutex;
  getIntentionalShutdowns(): Map<string, number>;
  assertReadinessReservationOwner(device: PooledDevice, client: AutolockClient | undefined): void;
  assertRuntimeIdentity(
    device: PooledDevice,
    identity: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): void;
  assertAndroidRecoveryExclusionForReadinessReservation(
    device: PooledDevice | undefined,
    identity: Pick<BootedDevice, "deviceId" | "name" | "platform">,
    stableRuntimeName: string,
    enforce: boolean,
  ): void;
  reserveShutdownSessionIdentity(deviceId: string): ShutdownIdentityReservation;
  completeShutdownSessionIdentity(
    deviceId: string,
    device: PooledDevice,
    identity: ShutdownIdentityReservation,
  ): void;
  reserveMcpSessionRecoveryLease(
    sessionId: string | undefined,
    device: PooledDevice,
    token: symbol | undefined,
  ): void;
  releaseMcpSessionRecoveryLease(sessionId: string | undefined, token: symbol | undefined): void;
  getOwnedAutolockSession(device: PooledDevice, client: AutolockClient | undefined): unknown;
}

/** Owns readiness and shutdown reservations while the pool retains ownership decisions. */
export class DeviceShutdownReservations {
  private readonly readinessReservationCounts: Map<string, number> = new Map();
  private readonly readinessReservationNames: Map<string, Map<symbol, ReadinessReservationTarget>> =
    new Map();
  private readonly shutdownReservations: Map<string, PooledDevice> = new Map();
  constructor(private readonly pool: DeviceShutdownReservationsPoolPort) {}

  /**
   * Keep an exact device out of general pool allocation while startDevice
   * verifies its runner. The reservation does not create a user-visible
   * session; session ownership is transferred only after readiness succeeds.
   * Android recovery exclusion defaults off because recovery handoffs reserve
   * their target while ownership transfer is still in flight.
   */
  async reserveDeviceForReadiness(
    deviceId: string,
    expectedIdentity: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
    stableRuntimeName = expectedIdentity.name,
    verifiedAndroidAvdName?: string,
    autolockClient?: AutolockClient,
    enforceAndroidRecoveryExclusion = false,
  ): Promise<DeviceReadinessReservation> {
    // The stable-name reservation exists to bridge an Android emulator changing
    // serials across a reboot. iOS UDIDs are stable, so a name reservation there
    // only hides other idle simulators that share a (non-unique) display name.
    const stableRuntimeKey = this.readinessReservationNameKey({
      name: stableRuntimeName,
      platform: expectedIdentity.platform,
    });
    const owner = Symbol("readiness-reservation");
    let trackStableName = false;
    await this.pool.getAssignmentMutex().runExclusive(async () => {
      throwIfRequestAborted();
      const pooled = this.pool.getDevices().get(deviceId);
      if (pooled) {
        // Acquisition may reboot a device during readiness recovery. Prove
        // ownership before reserving it or beginning those side effects.
        this.pool.assertReadinessReservationOwner(pooled, autolockClient);
        this.pool.assertRuntimeIdentity(pooled, expectedIdentity);
      }
      throwIfRequestAborted();
      const current = this.pool.getDevices().get(deviceId);
      this.pool.assertAndroidRecoveryExclusionForReadinessReservation(
        current,
        expectedIdentity,
        stableRuntimeName,
        enforceAndroidRecoveryExclusion,
      );
      trackStableName =
        current?.platform === "android" &&
        current.id.startsWith("emulator-") &&
        (current.avdName === stableRuntimeName || verifiedAndroidAvdName === stableRuntimeName);
      this.readinessReservationCounts.set(
        deviceId,
        (this.readinessReservationCounts.get(deviceId) ?? 0) + 1,
      );
      if (trackStableName && current) {
        const owners =
          this.readinessReservationNames.get(stableRuntimeKey) ??
          new Map<symbol, ReadinessReservationTarget>();
        owners.set(owner, { deviceId: current.id, incarnation: current.incarnation });
        this.readinessReservationNames.set(stableRuntimeKey, owners);
      }
    });

    let released = false;
    const release = async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      await this.pool.getAssignmentMutex().runExclusive(() => {
        const count = this.readinessReservationCounts.get(deviceId);
        if (count === undefined || count <= 1) {
          this.readinessReservationCounts.delete(deviceId);
        } else {
          this.readinessReservationCounts.set(deviceId, count - 1);
        }
        if (!trackStableName) {
          return;
        }
        const owners = this.readinessReservationNames.get(stableRuntimeKey);
        if (!owners) {
          return;
        }
        owners.delete(owner);
        if (owners.size === 0) {
          this.readinessReservationNames.delete(stableRuntimeKey);
        }
      });
    };
    return Object.assign(release, { owner });
  }

  isReservedForReadiness(deviceId: string): boolean {
    return (this.readinessReservationCounts.get(deviceId) ?? 0) > 0;
  }

  private readinessReservationNameKey(device: Pick<BootedDevice, "name" | "platform">): string {
    return `${device.platform}:${device.name}`;
  }

  hasReadinessNameReservation(
    device: PooledDevice,
    readinessReservationOwners?: ReadonlySet<symbol>,
  ): boolean {
    return (
      this.hasReadinessReservationName(
        this.readinessReservationNameKey(device),
        device,
        readinessReservationOwners,
      ) ||
      (device.avdName !== undefined &&
        this.hasReadinessReservationName(
          this.readinessReservationNameKey({ name: device.avdName, platform: device.platform }),
          device,
          readinessReservationOwners,
        ))
    );
  }

  private hasReadinessReservationName(
    nameKey: string,
    device: PooledDevice,
    readinessReservationOwners: ReadonlySet<symbol> | undefined,
  ): boolean {
    const owners = this.readinessReservationNames.get(nameKey);
    return (
      owners !== undefined &&
      Array.from(owners).some(
        ([owner, target]) =>
          (target.deviceId !== device.id || target.incarnation !== device.incarnation) &&
          !readinessReservationOwners?.has(owner),
      )
    );
  }

  /**
   * Exclusively reserve a captured incarnation while killDevice confirms it is
   * gone and retires its ownership. A replacement with the same ID remains
   * independently assignable once it has been atomically installed.
   */
  async reserveDeviceForShutdown(
    deviceId: string,
    abortSignal?: AbortSignal,
    autolockClient?: AutolockClient,
    assertHolder?: () => void,
  ): Promise<ShutdownDeviceReservation | undefined> {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error("Shutdown reservation cancelled");
    }
    const identity = this.pool.reserveShutdownSessionIdentity(deviceId);
    const recoveryRouteLease =
      autolockClient?.mcpSessionId && "expectedSessionId" in autolockClient ? Symbol() : undefined;
    const expectedDevice = await this.reserveShutdownDeviceWithAbort(
      deviceId,
      identity,
      abortSignal,
      autolockClient,
      recoveryRouteLease,
      assertHolder,
    );
    if (!expectedDevice) {
      identity.releaseSession?.();
      return undefined;
    }
    const capturedDevice = expectedDevice;

    let released = false;
    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      // Reservation ownership is identity-scoped. Releasing it does not mutate
      // the pool, so it must not queue behind a refresh holding assignmentMutex.
      if (this.shutdownReservations.get(capturedDevice.id) === capturedDevice) {
        this.shutdownReservations.delete(capturedDevice.id);
      }
      identity.releaseSession?.();
    };
    const releaseRecoveryRouteLease = () =>
      this.pool.releaseMcpSessionRecoveryLease(autolockClient?.mcpSessionId, recoveryRouteLease);
    return {
      device: capturedDevice,
      session: identity.session,
      release,
      releaseRecoveryRouteLease,
    };
  }

  private async reserveShutdownDeviceWithAbort(
    deviceId: string,
    identity: ShutdownIdentityReservation,
    abortSignal: AbortSignal | undefined,
    autolockClient: AutolockClient | undefined,
    recoveryRouteLease: symbol | undefined,
    assertHolder: (() => void) | undefined,
  ): Promise<PooledDevice | undefined> {
    const releaseSessionOnAbort = () => identity.releaseSession?.();
    abortSignal?.addEventListener("abort", releaseSessionOnAbort, { once: true });
    try {
      const expectedDevice = await this.reserveShutdownDeviceUnderLock(
        deviceId,
        identity,
        abortSignal,
        autolockClient,
        recoveryRouteLease,
        assertHolder,
      );
      if (abortSignal?.aborted) {
        if (expectedDevice && this.shutdownReservations.get(deviceId) === expectedDevice) {
          this.shutdownReservations.delete(deviceId);
        }
        throw abortSignal.reason ?? new Error("Shutdown reservation cancelled");
      }
      return expectedDevice;
    } catch (error) {
      this.pool.releaseMcpSessionRecoveryLease(autolockClient?.mcpSessionId, recoveryRouteLease);
      identity.releaseSession?.();
      throw error;
    } finally {
      abortSignal?.removeEventListener("abort", releaseSessionOnAbort);
    }
  }

  private async reserveShutdownDeviceUnderLock(
    deviceId: string,
    identity: ShutdownIdentityReservation,
    abortSignal: AbortSignal | undefined,
    autolockClient: AutolockClient | undefined,
    recoveryRouteLease: symbol | undefined,
    assertHolder: (() => void) | undefined,
  ): Promise<PooledDevice | undefined> {
    return await this.pool.getAssignmentMutex().runExclusive(() => {
      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new Error("Shutdown reservation cancelled");
      }
      const currentDevice = this.pool.getDevices().get(deviceId);
      if (
        identity.device &&
        (currentDevice !== identity.device ||
          currentDevice.assignmentCount !== identity.assignmentCount)
      ) {
        throw new ActionableError(
          `Device '${deviceId}' changed while its shutdown was being reserved.`,
        );
      }
      if (!currentDevice) {
        return undefined;
      }
      // A readiness await can outlive this client's ownership. Check it while
      // reserving shutdown so a stale request cannot reboot another session's device.
      this.pool.getOwnedAutolockSession(currentDevice, autolockClient);
      // The caller's entry-time ownership check predates its lifecycle-lease wait; a start can
      // bind another session meanwhile, so the holder is re-checked under the assignment mutex.
      assertHolder?.();
      if (this.shutdownReservations.get(deviceId) === currentDevice) {
        throw new ActionableError(`Device '${deviceId}' is already shutting down.`);
      }
      this.pool.completeShutdownSessionIdentity(deviceId, currentDevice, identity);
      this.pool.reserveMcpSessionRecoveryLease(
        autolockClient?.mcpSessionId,
        currentDevice,
        recoveryRouteLease,
      );
      this.shutdownReservations.set(deviceId, currentDevice);
      return currentDevice;
    });
  }

  isReservedForShutdown(device: PooledDevice): boolean {
    return this.shutdownReservations.get(device.id) === device;
  }

  /** Whether an active reservation holds the current device or its absent slot. */
  isDeviceUnderShutdownReservation(deviceId: string): boolean {
    const device = this.pool.getDevices().get(deviceId);
    const reservation = this.shutdownReservations.get(deviceId);
    return reservation !== undefined && (device === undefined || reservation === device);
  }

  /**
   * Whether the currently-bound incarnation of a device is being killed: either
   * held under an active shutdown reservation, or carrying an intentional-shutdown
   * marker that applies to the current incarnation. Incarnation-gated (mirroring
   * {@link DeviceDisconnectHandler.applyIntentionalShutdownOnDisconnect}) so a same-serial replacement,
   * whose own marker/reservation lifecycle is independent, is not blocked by a
   * stale marker left behind by a device that is already gone.
   */
  isDeviceUnderShutdown(deviceId: string): boolean {
    if (this.isDeviceUnderShutdownReservation(deviceId)) {
      return true;
    }
    const device = this.pool.getDevices().get(deviceId);
    const markerIncarnation = this.pool.getIntentionalShutdowns().get(deviceId);
    if (markerIncarnation === undefined) {
      return false;
    }
    return (
      device === undefined ||
      markerIncarnation === INCARNATION_ANY ||
      markerIncarnation === device.incarnation
    );
  }

  /** Read the shutdown fence under the assignment lock used to install it. */
  // Do not call inside assignmentMutex.runExclusive: this accessor takes the same mutex.
  async isShutdownReserved(deviceId: string): Promise<boolean> {
    return await this.pool
      .getAssignmentMutex()
      .runExclusive(() => this.isDeviceUnderShutdown(deviceId));
  }

  /** Read only the active shutdown reservation under the assignment lock. */
  // Do not call inside assignmentMutex.runExclusive: this accessor takes the same mutex.
  async isShutdownReservationHeld(deviceId: string): Promise<boolean> {
    return await this.pool
      .getAssignmentMutex()
      .runExclusive(() => this.isDeviceUnderShutdownReservation(deviceId));
  }
}
