import { captureAutolockPolicy } from "./deviceAutolockPolicy";
import { logger } from "../utils/logger";
import { ActionableError, type BootedDevice, type DeviceInfo, type Platform } from "../models";
import { getAbortSignal, throwIfRequestAborted } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer } from "../utils/SystemTimer";
import { type IdGenerator } from "../utils/IdGenerator";
import type { DeviceReadinessLevel } from "../devices/DeviceSessionManager";
import { getDevicePoolTimeoutMs, type Environment } from "./poolConfig";
import type { DeviceSessionRepository } from "../db/deviceSessionRepository";
import type { Session, SessionExecutionMetadata, SessionManager } from "./sessionManager";
import type {
  DeviceAutolockChildProcess,
  PooledDevice,
  SessionAssignmentSnapshot,
  TargetDeviceDiscoveryOptions,
  TargetDeviceDiscoverySnapshot,
  TargetDeviceValidationOptions,
} from "./devicePool";

export type AutolockClient = { mcpSessionId?: string; expectedSessionId?: string };

export class McpSessionRecoveryInProgressError extends ActionableError {
  constructor(mcpSessionId: string) {
    super(
      `MCP session '${mcpSessionId}' is recovering a device and cannot remap until recovery finishes.`,
    );
  }
}

type ExpectedIdentity = Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">;

interface AutolockAcquisitionOptions {
  snapshot: TargetDeviceDiscoverySnapshot;
  deviceId: string;
  platform: Platform;
  mcpSessionId?: string;
  sourceImage?: DeviceInfo;
  childProcess?: DeviceAutolockChildProcess | null;
  expectedIdentity?: ExpectedIdentity;
  readinessReservationOwners?: ReadonlySet<symbol>;
  verifiedAndroidAvdIdentity?: DeviceInfo;
  achievedReadiness: DeviceReadinessLevel;
  collectCancellationSettlement?: (settlement: Promise<void>) => void;
}

export interface DeviceAutolockPoolPort {
  getSessionManager(): SessionManager;
  getDaemonSessionId(): string;
  getDevice(id: string): PooledDevice | undefined;
  withAssignmentLock<T>(operation: () => Promise<T> | T): Promise<T>;
  withTargetDeviceDiscovery(options: TargetDeviceDiscoveryOptions): Promise<string>;
  assertRuntimeIdentity(device: PooledDevice, identity: ExpectedIdentity | undefined): void;
  assertNotReservedForShutdown(device: PooledDevice, message: string): void;
  recordSourceAndroidAvd(id: string, image: DeviceInfo | undefined): void;
  notifyTargetDeviceReady(options: {
    device: PooledDevice;
    snapshot: TargetDeviceDiscoverySnapshot;
  }): void;
  trackStartedDeviceProcess(
    device: BootedDevice,
    process: DeviceAutolockChildProcess | null | undefined,
  ): Promise<void>;
  assertIdleDeviceAssignable(options: TargetDeviceValidationOptions): void;
  validateOrReloadIdlePooledDevice(
    options: TargetDeviceValidationOptions,
  ): Promise<PooledDevice | undefined>;
  assertDeviceCleanupComplete(id: string): void;
  snapshotSessionAssignment(device: PooledDevice): SessionAssignmentSnapshot;
  nextLastUsedAt(): number;
  createSessionOrRestore(
    device: PooledDevice,
    snapshot: SessionAssignmentSnapshot,
    create: () => Promise<Session>,
  ): Promise<Session>;
  stableDeviceIdFor(device: PooledDevice): string | undefined;
  recordMcpSessionOwnership(client: string, session: string): void;
  restoreSessionAssignment(device: PooledDevice, snapshot: SessionAssignmentSnapshot): void;
  isSessionAssignmentCurrent(device: PooledDevice, session: Session): boolean;
  getPooledSessionIdentity(device: PooledDevice): Session | undefined;
  getMcpSessionRecoveryDevice(client: string): PooledDevice | undefined;
  isAdbServerResetQuarantined(id: string): boolean;
}

/** Owns implicit MCP routing and exclusive autolock acquisition. Pool mutations stay on its injected port. */
export class DeviceAutolockManager {
  private readonly mcpSessionAcquiredAutolocks = new Map<string, Set<string>>();
  // The latest route may be stricter than the complete acquired set on a warm retry.
  private readonly mcpSessionAutolockMap = new Map<string, string>();

  constructor(
    private readonly pool: DeviceAutolockPoolPort,
    private readonly deviceSessionRepository: Pick<DeviceSessionRepository, "markAutolockSession">,
    private readonly idGenerator: IdGenerator,
    private readonly env?: Environment,
  ) {}

  /**
   * Lock a device with an autolock session ID.
   *
   * Creates a session UUID or reuses the proven caller's live autolock. When enabled,
   * subsequent tool calls from the same MCP session can resolve this UUID
   * implicitly; other clients must include it explicitly. The session has a
   * configurable idle timeout (AUTO_MOBILE_DEVICE_POOL_TIMEOUT).
   *
   * @param deviceId - The device to lock
   * @param platform - Device platform
   * @returns The assigned session ID, or undefined if autolock is disabled
   */
  async autolockDevice(
    ...[
      deviceId,
      platform,
      mcpSessionId,
      sourceImage,
      childProcess,
      expectedIdentity,
      readinessReservationOwners,
      verifiedAndroidAvdIdentity,
      achievedReadiness = "automationReady",
      collectCancellationSettlement,
      policy = {},
    ]: [
      deviceId: string,
      platform: Platform,
      mcpSessionId?: string,
      sourceImage?: DeviceInfo,
      childProcess?: DeviceAutolockChildProcess | null,
      expectedIdentity?: ExpectedIdentity,
      readinessReservationOwners?: ReadonlySet<symbol>,
      verifiedAndroidAvdIdentity?: DeviceInfo,
      achievedReadiness?: DeviceReadinessLevel,
      collectCancellationSettlement?: (settlement: Promise<void>) => void,
      policy?: { autolockEnabled?: boolean },
    ]
  ): Promise<string | undefined> {
    if (!(policy.autolockEnabled ?? captureAutolockPolicy(this.env))) {
      return undefined;
    }
    return this.pool.withTargetDeviceDiscovery({
      deviceId,
      sourceImage: verifiedAndroidAvdIdentity ?? sourceImage,
      unavailableMessage: this.unavailableMessage(deviceId),
      platform,
      operation: (snapshot) =>
        this.autolockDeviceExclusive({
          snapshot,
          deviceId,
          platform,
          mcpSessionId,
          sourceImage,
          childProcess,
          expectedIdentity,
          readinessReservationOwners,
          verifiedAndroidAvdIdentity,
          achievedReadiness,
          collectCancellationSettlement,
        }),
    });
  }

  private async autolockDeviceExclusive({
    snapshot,
    deviceId,
    platform,
    mcpSessionId,
    sourceImage,
    childProcess,
    expectedIdentity,
    readinessReservationOwners,
    verifiedAndroidAvdIdentity,
    achievedReadiness,
    collectCancellationSettlement,
  }: AutolockAcquisitionOptions): Promise<string | undefined> {
    throwIfRequestAborted();
    const androidAvdIdentity = verifiedAndroidAvdIdentity ?? sourceImage;

    // The shared discovery pass has added a freshly booted target under the lock.
    const alreadyPooled = snapshot.capturedEntry !== undefined;
    // Assign the device to the generated session
    throwIfRequestAborted();
    let device = this.pool.getDevice(deviceId);
    if (!device) {
      throw new ActionableError(this.unavailableMessage(deviceId));
    }
    this.assertMcpSessionCanAutolockDevice(mcpSessionId, device);
    this.pool.assertRuntimeIdentity(device, expectedIdentity);
    this.pool.assertNotReservedForShutdown(
      device,
      `Device '${deviceId}' is shutting down and cannot be autolocked.`,
    );
    if (alreadyPooled) {
      this.pool.recordSourceAndroidAvd(deviceId, androidAvdIdentity);
      this.pool.notifyTargetDeviceReady({ device, snapshot });
    }
    await this.pool.trackStartedDeviceProcess(
      {
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
      },
      childProcess,
    );
    if (this.pool.getDevice(deviceId) !== device) {
      throw new ActionableError(`Device '${deviceId}' exited before it could be autolocked.`);
    }
    this.throwIfFreshStartAlreadyBound(device, sourceImage, mcpSessionId);
    this.pool.assertIdleDeviceAssignable({
      device,
      unavailableMessage:
        `Device '${deviceId}' is not available for autolock.\n` +
        `The device may have been shut down or disconnected.`,
      readinessReservationOwners,
      snapshot,
    });

    const validatedDevice = await this.pool.validateOrReloadIdlePooledDevice({
      device,
      expectedIdentity,
      unavailableMessage: this.unavailableMessage(deviceId),
      readinessReservationOwners,
      snapshot,
    });
    if (!validatedDevice) {
      return undefined;
    }
    device = validatedDevice;

    throwIfRequestAborted();
    const reusedSessionId = await this.reuseOwnedAutolockSession(
      device,
      mcpSessionId,
      achievedReadiness,
    );
    if (reusedSessionId) {
      return reusedSessionId;
    }

    if (this.pool.getDevice(deviceId) !== device) {
      return undefined;
    }
    this.pool.assertDeviceCleanupComplete(deviceId);
    const sessionId = this.idGenerator.next();
    const assignmentSnapshot = this.pool.snapshotSessionAssignment(device);
    device.sessionId = sessionId;
    device.status = "busy";
    device.lastUsedAt = this.pool.nextLastUsedAt();
    device.assignmentCount++;
    device.autolockSessionId = sessionId;

    const timeoutMs = getDevicePoolTimeoutMs();
    // The idle timeout is the lock's lease: only tool calls (session resolution)
    // extend `expiresAt`. A heartbeat (a stdio proxy ticks one every few seconds
    // for as long as it is connected) proves the owner is alive, not that the
    // device is in use, so it must not extend the idle deadline (#10656, #10658).
    // Liveness uses the default owner lease (`sessionLivenessWindows.ts`), the
    // same as a bound session: an owner that stops heartbeating without closing
    // its connection frees the device within lease + grace + one scan (~10 s),
    // not after the idle window (#10729). A `--cli` owner never heartbeats; it
    // declares the CLI liveness policy, which moves the session onto wall-clock
    // idleness instead.
    const session = await this.pool.createSessionOrRestore(device, assignmentSnapshot, () =>
      this.pool
        .getSessionManager()
        .createSession(
          sessionId,
          deviceId,
          platform,
          timeoutMs,
          undefined,
          this.pool.stableDeviceIdFor(device),
        ),
    );
    // #6227 (round 9): record the achieved readiness BEFORE publishing the
    // autolock route below. `mcpSessionAutolockMap.set` makes this session
    // reachable to a concurrent tool call from the same MCP client (via
    // `resolveAutolockSessionForMcpClient`); if that call resolved the session
    // and consulted `getDeviceReadiness` before the caller recorded the level,
    // it would see an unrecorded readiness and redundantly re-run (or wrongly
    // skip) setup. The setter is monotonic, so recording here is safe even for
    // a restored session that already reached a higher level.
    this.pool.getSessionManager().setDeviceReadiness(sessionId, achievedReadiness);
    if (mcpSessionId) {
      this.mcpSessionAutolockMap.set(mcpSessionId, sessionId);
      const acquired = this.mcpSessionAcquiredAutolocks.get(mcpSessionId) ?? new Set<string>();
      acquired.add(sessionId);
      this.mcpSessionAcquiredAutolocks.set(mcpSessionId, acquired);
      this.pool.recordMcpSessionOwnership(mcpSessionId, sessionId);
    }
    await this.persistAcquiredAutolockSession(
      device,
      session,
      assignmentSnapshot,
      mcpSessionId,
      collectCancellationSettlement,
    );

    logger.info(
      `Autolocked device ${deviceId} with session ${sessionId} (timeout: ${timeoutMs}ms)`,
    );
    return sessionId;
  }

  private unavailableMessage(deviceId: string): string {
    return (
      `Device '${deviceId}' is not available for autolock.\n` +
      `The device may have been shut down or disconnected.\n\n` +
      `Options:\n` +
      `  - Use 'getAndroid' or 'getApple' with the target's stable identifier to prepare a device\n` +
      `  - Use the returned sessionUuid to target this specific device\n` +
      `  - Use 'listDevices' to see currently available devices`
    );
  }

  private async persistAcquiredAutolockSession(
    device: PooledDevice,
    session: Session,
    snapshot: SessionAssignmentSnapshot,
    mcpSessionId?: string,
    collectCancellationSettlement?: (settlement: Promise<void>) => void,
  ): Promise<void> {
    const signal = getAbortSignal();
    const cancelPublishedSession = async () => {
      // Only this newly minted session may be compensated; never a replacement.
      await this.pool
        .getSessionManager()
        .releaseSessionIfOwned(session.sessionId, session, device.id, "session-creation-cancelled");
    };
    try {
      signal?.throwIfAborted();
      const persistence = this.deviceSessionRepository.markAutolockSession(session.sessionId, {
        mcpSessionId: mcpSessionId ?? null,
        daemonSessionId: this.pool.getDaemonSessionId(),
        lastUsedAtMs: session.lastUsedAt,
        expiresAtMs: session.expiresAt,
      });
      await raceWithDeadline(persistence, {
        timer: defaultTimer,
        signal,
        label: "Autolock persistence",
      });
      signal?.throwIfAborted();
    } catch (error) {
      // Session release fences automation admission synchronously, then may
      // wait for teardown/durable persistence. Neither that wait nor the late
      // metadata write may hold the global assignment mutex after cancellation.
      // The repository's active-row guard prevents the late metadata write from
      // overwriting a completed terminal release.
      const cancellationSettlement = cancelPublishedSession();
      collectCancellationSettlement?.(cancellationSettlement);
      void cancellationSettlement.catch((releaseError) =>
        logger.warn(`Cancelled autolock release failed: ${releaseError}`),
      );
      this.restoreCancelledAutolockAssignment(device, session, snapshot);
      throw error;
    }
  }

  private restoreCancelledAutolockAssignment(
    device: PooledDevice,
    session: Session,
    snapshot: SessionAssignmentSnapshot,
  ): void {
    if (
      session.assignedDevice === device.id &&
      this.pool.getSessionManager().isLatestSessionIdentity(session)
    ) {
      this.clearMcpAutolockMappings(session.sessionId);
    }
    if (
      this.pool.getDevice(device.id) === device &&
      device.sessionId === session.sessionId &&
      device.assignmentCount === snapshot.assignmentCount + 1 &&
      this.pool.getPooledSessionIdentity(device) === session
    ) {
      this.pool.restoreSessionAssignment(device, snapshot);
    }
  }

  private assertMcpSessionCanAutolockDevice(
    mcpSessionId: string | undefined,
    device: PooledDevice,
  ): void {
    if (
      mcpSessionId &&
      this.pool.getMcpSessionRecoveryDevice(mcpSessionId) !== undefined &&
      this.pool.getMcpSessionRecoveryDevice(mcpSessionId) !== device
    ) {
      throw new McpSessionRecoveryInProgressError(mcpSessionId);
    }
  }

  /** Warm acquisition must prove ownership before reusing a live autolock. */
  private async reuseOwnedAutolockSession(
    device: PooledDevice,
    mcpSessionId: string | undefined,
    achievedReadiness: DeviceReadinessLevel,
  ): Promise<string | undefined> {
    const session = this.getOwnedAutolockSession(device, { mcpSessionId });
    if (!session) {
      return undefined;
    }
    const refreshed = await this.pool.getSessionManager().getOrCreateSession(session.sessionId);
    // Release can finish while activity persistence yields, even under the
    // assignment mutex. Do not report success for a retired ownership identity.
    if (
      refreshed !== session ||
      !this.pool.isSessionAssignmentCurrent(device, session) ||
      !this.pool.getSessionManager().isAdmittedForAutomation(session)
    ) {
      throw new ActionableError(`Device '${device.id}' was released during autolock acquisition.`);
    }
    this.pool.getSessionManager().setDeviceReadiness(session.sessionId, achievedReadiness);
    return session.sessionId;
  }

  getOwnedAutolockSession(
    device: PooledDevice,
    client: AutolockClient | undefined,
  ): Session | undefined {
    if (!client) {
      return undefined;
    }
    const { mcpSessionId } = client;
    if (
      "expectedSessionId" in client &&
      mcpSessionId &&
      this.mcpSessionAutolockMap.get(mcpSessionId) !== client.expectedSessionId
    ) {
      throw new ActionableError(
        `Device '${device.id}' is already assigned to another session. ` +
          "Acquire a different device or wait for its owner to release it.",
      );
    }
    const session = device.sessionId
      ? this.pool.getSessionManager().getSession(device.sessionId)
      : null;
    if (!session) {
      return undefined;
    }
    if (!this.isOwnedAutolockSession(device, session, mcpSessionId)) {
      throw new ActionableError(
        `Device '${device.id}' is already assigned to another session. ` +
          "Acquire a different device or wait for its owner to release it.",
      );
    }
    return session;
  }

  private isOwnedAutolockSession(
    device: PooledDevice,
    session: Session,
    mcpSessionId: string | undefined,
  ): boolean {
    return (
      mcpSessionId !== undefined &&
      this.mcpSessionAutolockMap.get(mcpSessionId) === session.sessionId &&
      device.autolockSessionId === session.sessionId &&
      this.pool.isSessionAssignmentCurrent(device, session) &&
      this.pool.getSessionManager().isAdmittedForAutomation(session)
    );
  }

  captureAutolockSessionForMcpSession(mcpSessionId: string | undefined): string | undefined {
    return mcpSessionId ? this.mcpSessionAutolockMap.get(mcpSessionId) : undefined;
  }

  private throwIfFreshStartAlreadyBound(
    device: PooledDevice,
    sourceImage: DeviceInfo | undefined,
    mcpSessionId: string | undefined,
  ): void {
    if (!sourceImage || !device.sessionId) {
      return;
    }
    const existingSession = this.pool.getSessionManager().getSession(device.sessionId);
    if (
      existingSession &&
      existingSession.assignedDevice === device.id &&
      existingSession.platform === device.platform
    ) {
      if (this.isOwnedAutolockSession(device, existingSession, mcpSessionId)) {
        return;
      }
      throw new ActionableError(
        `Freshly started device '${device.id}' was assigned to session ` +
          `${existingSession.sessionId} before its owning session could reserve it.`,
      );
    }
  }

  /**
   * Resolve the autolock session associated with an MCP client session.
   *
   * startDevice binds its generated device-session UUID to the MCP session that
   * called it. Later tool calls from the same MCP session can omit sessionUuid;
   * this lookup restores the device-session UUID while it is still live.
   */
  resolveAutolockSessionForMcpSession(
    mcpSessionId: string | undefined,
    platform?: Platform,
    execution?: SessionExecutionMetadata,
    deviceId?: string,
  ): string | undefined {
    if (!mcpSessionId) {
      return undefined;
    }

    if (platform || deviceId) {
      const selected = this.resolveAutolockDeviceSelector(
        mcpSessionId,
        platform,
        execution,
        deviceId,
      );
      if (selected || deviceId) {
        return selected;
      }
    }

    return this.resolveLatestAutolockSession(mcpSessionId, platform, execution);
  }

  private resolveLatestAutolockSession(
    mcpSessionId: string,
    platform: Platform | undefined,
    execution: SessionExecutionMetadata | undefined,
  ): string | undefined {
    const sessionId = this.mcpSessionAutolockMap.get(mcpSessionId);
    if (!sessionId) {
      return undefined;
    }

    const session = this.pool.getSessionManager().getSessionForNewExecution(sessionId, execution);
    if (!session) {
      this.mcpSessionAutolockMap.delete(mcpSessionId);
      return undefined;
    }

    const device = this.pool.getDevice(session.assignedDevice);
    if (!device || device.autolockSessionId !== sessionId) {
      if (this.pool.isAdbServerResetQuarantined(sessionId)) {
        return !platform || session.platform === platform ? sessionId : undefined;
      }
      this.mcpSessionAutolockMap.delete(mcpSessionId);
      return undefined;
    }

    if (platform && device.platform !== platform) {
      return undefined;
    }

    return sessionId;
  }

  private resolveAutolockDeviceSelector(
    mcpSessionId: string,
    platform: Platform | undefined,
    execution: SessionExecutionMetadata | undefined,
    deviceId: string | undefined,
  ): string | undefined {
    const candidates = [...(this.mcpSessionAcquiredAutolocks.get(mcpSessionId) ?? [])].flatMap(
      (id) => {
        const session = this.pool.getSessionManager().getSessionForNewExecution(id, execution);
        if (!session) {
          return [];
        }
        const device = this.pool.getDevice(session.assignedDevice);
        if (device && device.autolockSessionId === id && device.sessionId === id) {
          return [
            { sessionId: id, deviceId: device.id, platform: device.platform, recovering: false },
          ];
        }
        // A session detached by a process-wide ADB reset is still owned by this
        // MCP connection; its device is simply absent from the pool while the
        // reset is recovered. Dropping it here would let an implicit selector
        // silently route to the connection's *other* device (#6807).
        return this.pool.isAdbServerResetQuarantined(id)
          ? [
              {
                sessionId: id,
                deviceId: session.assignedDevice,
                platform: session.platform,
                recovering: true,
              },
            ]
          : [];
      },
    );
    const matches = candidates.filter(
      (candidate) =>
        (!platform || candidate.platform === platform) &&
        (!deviceId || candidate.deviceId === deviceId),
    );
    if (matches.length === 1) {
      // A lone recovering match is not ambiguous: returning it lets the caller
      // surface the recovery error for the device the client actually owns.
      return matches[0].sessionId;
    }
    if (candidates.length > 0 && !deviceId) {
      throw new ActionableError(
        `Cannot resolve requested platform/deviceId unambiguously. Candidate sessions: ${candidates
          .map(
            (candidate) =>
              `${candidate.sessionId} (${candidate.deviceId}, ${candidate.platform}` +
              `${candidate.recovering ? ", recovering" : ""})`,
          )
          .join(", ")}. Pass an explicit sessionUuid/deviceId.`,
      );
    }
    return undefined;
  }

  /** Restore retained capabilities without letting an older queued request reset the default. */
  async restoreAutolockSessionsForMcpSession(
    sessionIds: readonly string[],
    mcpSessionId: string,
  ): Promise<void> {
    for (const id of sessionIds) {
      // Nothing left to restore for a session this connection already holds
      // while it also already has a default. Re-checked each iteration rather
      // than snapshotted, so an attachment cannot act on a stale reading.
      if (
        this.mcpSessionAcquiredAutolocks.get(mcpSessionId)?.has(id) &&
        this.resolveAutolockSessionForMcpSession(mcpSessionId) !== undefined
      ) {
        continue;
      }
      // "if-absent" defers the default decision to attach time, under the
      // assignment mutex. A pre-loop snapshot would be stale by the time the
      // second attachment runs, letting restoration clobber a `setActiveDevice`
      // that landed in between (#6807).
      await this.attachAutolockSessionToMcpSession(id, mcpSessionId, "if-absent");
    }
  }

  /**
   * Associate a live autolock session with a reconnected MCP client session.
   */
  async attachAutolockSessionToMcpSession(
    sessionId: string,
    mcpSessionId: string | undefined,
    makeDefault: boolean | "if-absent" = true,
  ): Promise<void> {
    if (!mcpSessionId) {
      return;
    }
    await this.pool.withAssignmentLock(async () => {
      const session = this.pool.getSessionManager().getSession(sessionId);
      const device = session ? this.pool.getDevice(session.assignedDevice) : undefined;
      if (
        !session ||
        !device ||
        device.sessionId !== sessionId ||
        device.autolockSessionId !== sessionId
      ) {
        return;
      }
      this.assertMcpSessionCanAutolockDevice(mcpSessionId, device);
      await this.deviceSessionRepository.markAutolockSession(sessionId, {
        mcpSessionId,
        daemonSessionId: this.pool.getDaemonSessionId(),
        lastUsedAtMs: session.lastUsedAt,
        expiresAtMs: session.expiresAt,
      });
      if (
        makeDefault === true ||
        (makeDefault === "if-absent" &&
          this.resolveAutolockSessionForMcpSession(mcpSessionId) === undefined)
      ) {
        this.mcpSessionAutolockMap.set(mcpSessionId, sessionId);
      }
      const acquired = this.mcpSessionAcquiredAutolocks.get(mcpSessionId) ?? new Set<string>();
      acquired.add(sessionId);
      this.mcpSessionAcquiredAutolocks.set(mcpSessionId, acquired);
    });
  }

  clearExpiredAutolockStateWhenIdle(
    sessionId: string,
    expectedDevice: PooledDevice,
    expectedAssignmentCount: number,
  ): void {
    if (
      this.pool.getDevice(expectedDevice.id) !== expectedDevice ||
      expectedDevice.assignmentCount !== expectedAssignmentCount ||
      expectedDevice.sessionId !== null ||
      expectedDevice.autolockSessionId !== sessionId
    ) {
      return;
    }

    expectedDevice.autolockSessionId = undefined;
    this.clearMcpAutolockMappings(sessionId);
  }

  /** Unlock only the captured old device while the session remains alive after rebind. */
  clearRebindAutolockLock(sessionId: string, deviceId: string, expectedDevice: PooledDevice): void {
    const device = this.pool.getDevice(deviceId);
    if (!device || device !== expectedDevice || device.autolockSessionId !== sessionId) {
      return;
    }

    device.autolockSessionId = undefined;
  }

  /** Clear autolock-only state for an explicit release without freeing early. */
  clearReleasedAutolockState(sessionId: string, deviceId: string): void {
    const device = this.pool.getDevice(deviceId);
    if (!device || device.autolockSessionId !== sessionId) {
      return;
    }

    device.autolockSessionId = undefined;
    this.clearMcpAutolockMappings(sessionId);
  }

  private clearMcpAutolockMappings(sessionId: string): void {
    for (const [mcpSessionId, acquired] of this.mcpSessionAcquiredAutolocks) {
      acquired.delete(sessionId);
      if (acquired.size === 0) {
        this.mcpSessionAcquiredAutolocks.delete(mcpSessionId);
      }
    }
    for (const [mcpSessionId, mappedSessionId] of this.mcpSessionAutolockMap) {
      if (mappedSessionId === sessionId) {
        this.mcpSessionAutolockMap.delete(mcpSessionId);
      }
    }
  }

  /**
   * Assert that a session is permitted to interact with a device.
   *
   * When autolock is enabled and a device is locked to a session, only that
   * session UUID may drive it. A mismatched or absent session UUID is rejected.
   * No-op when autolock is disabled or the device is not locked.
   */
  assertAutolockAccess(
    deviceId: string,
    sessionUuid: string | undefined,
    autolockEnabled = captureAutolockPolicy(this.env),
  ): void {
    if (!autolockEnabled) {
      return;
    }

    const device = this.pool.getDevice(deviceId);
    if (!device || !device.autolockSessionId) {
      return;
    }

    if (device.autolockSessionId !== sessionUuid) {
      throw new ActionableError(
        `Device '${deviceId}' is locked to another session.\n` +
          `Autolock is enabled, so tool calls must either come from the same MCP session ` +
          `that called 'getAndroid' or 'getApple', or include the sessionUuid returned for this device.\n\n` +
          `Options:\n` +
          `  - Pass the sessionUuid from getAndroid or getApple that locked this device\n` +
          `  - Use getAndroid or getApple to lock a different available device\n` +
          `  - Wait for the idle timeout to release this device`,
      );
    }
  }

  /** Whether any connected MCP client still acquired or routes to the autolock session. */
  hasMcpSessionOwner(sessionId: string): boolean {
    for (const acquired of this.mcpSessionAcquiredAutolocks.values()) {
      if (acquired.has(sessionId)) {
        return true;
      }
    }
    for (const mappedSessionId of this.mcpSessionAutolockMap.values()) {
      if (mappedSessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  releaseMcpSessionBindings(mcpSessionId: string): void {
    this.mcpSessionAcquiredAutolocks.delete(mcpSessionId);
    this.mcpSessionAutolockMap.delete(mcpSessionId);
  }
}
