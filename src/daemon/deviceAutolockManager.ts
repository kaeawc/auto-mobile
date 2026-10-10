import { captureAutolockPolicy } from "./deviceAutolockPolicy";
import {
  deviceAlreadyAssignedToAnotherSessionError,
  InputDeviceOwnedError,
} from "./inputDeviceOwnership";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { ActionableError, type BootedDevice, type DeviceInfo, type Platform } from "../models";
import { getAbortSignal, throwIfRequestAborted } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer } from "../utils/SystemTimer";
import { type IdGenerator } from "../utils/IdGenerator";
import type { DeviceReadinessLevel } from "../devices/DeviceSessionManager";
import { getDevicePoolTimeoutMs, type Environment } from "./poolConfig";
import { freshStartAlreadyBoundError } from "./deviceAcquisitionRefusals";
import type { DeviceSessionRepository } from "../db/deviceSessionRepository";
import type { Session, SessionExecutionMetadata, SessionManager } from "./sessionManager";

/**
 * Result of attaching an autolock session to an MCP session (#11129). `attached-not-persisted`
 * routes in this daemon but its row write failed (already logged), so a restart will not restore it.
 */
export type AutolockAttachOutcome = "attached" | "attached-not-persisted" | "not-attached";
import type {
  DeviceAutolockChildProcess,
  PooledDevice,
  SessionAssignmentSnapshot,
  TargetDeviceDiscoveryOptions,
  TargetDeviceDiscoverySnapshot,
  TargetDeviceValidationOptions,
} from "./devicePool";

export type AutolockClient = {
  mcpSessionId?: string;
  expectedSessionId?: string;
  /** A one-shot `--cli` caller: anonymous, so it may act only on anonymous sessions (#11096). */
  oneShotCli?: boolean;
};

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
  /** Records the owner unless its connection closed mid-acquire; false means not recorded. */
  recordBindOwnership(client: string, session: string): boolean;
  restoreSessionAssignment(device: PooledDevice, snapshot: SessionAssignmentSnapshot): void;
  isSessionAssignmentCurrent(device: PooledDevice, session: Session): boolean;
  getPooledSessionIdentity(device: PooledDevice): Session | undefined;
  getMcpSessionRecoveryDevice(client: string): PooledDevice | undefined;
  isAdbServerResetQuarantined(id: string): boolean;
  /** Refuse a device another live daemon claims, like an explicit bind (#10980). */
  assertNotClaimedByForeignDaemon(deviceId: string, platform: Platform): Promise<void>;
  /** Publish this daemon's claim, rolling a fresh acquisition back when another daemon won. */
  claimAcquiredDevice(
    sessionId: string,
    deviceId: string,
    heldBefore: string | null,
    platform: Platform,
  ): Promise<void>;
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
    // Two daemons must never drive one device (#10980, #11071): check before assigning, then
    // publish the claim or roll the acquisition back, as an explicit bind does.
    await this.pool.assertNotClaimedByForeignDaemon(deviceId, platform);
    const heldBefore = this.pool.getDevice(deviceId)?.sessionId ?? null;
    const sessionId = await this.pool.withTargetDeviceDiscovery({
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
    if (sessionId) {
      await this.pool.claimAcquiredDevice(sessionId, deviceId, heldBefore, platform);
    }
    return sessionId;
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
    this.pool.assertNotReservedForShutdown(device, "and cannot be autolocked");
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
    // A connection that closed mid-acquire already had its bindings released: publishing its
    // routes now would leave a dead owner that suppresses the owner-disconnect release (#11166).
    const owner =
      mcpSessionId && this.pool.recordBindOwnership(mcpSessionId, sessionId)
        ? mcpSessionId
        : undefined;
    if (owner) {
      this.mcpSessionAutolockMap.set(owner, sessionId);
      const acquired = this.mcpSessionAcquiredAutolocks.get(owner) ?? new Set<string>();
      acquired.add(sessionId);
      this.mcpSessionAcquiredAutolocks.set(owner, acquired);
    }
    // A refused owner is not persisted either, so a restart cannot restore it (#11192).
    await this.persistAcquiredAutolockSession(
      device,
      session,
      assignmentSnapshot,
      owner,
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
      const sessions = this.pool.getSessionManager();
      // Persisted stamps are wall epoch ms, shared by every process (#11162).
      const persistence = this.deviceSessionRepository.markAutolockSession(session.sessionId, {
        mcpSessionId: mcpSessionId ?? null,
        daemonSessionId: this.pool.getDaemonSessionId(),
        lastUsedAtMs: sessions.sessionClockToWall(session.lastUsedAt),
        expiresAtMs: sessions.sessionClockToWall(session.expiresAt),
      });
      try {
        await raceWithDeadline(persistence, {
          timer: defaultTimer,
          signal,
          label: "Autolock persistence",
        });
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        // A transient write failure (e.g. SQLITE_BUSY past the retry) leaves the live session
        // usable in memory, exactly like the attach path's attached-not-persisted (#11164):
        // only abort/deadline cancels the acquisition.
        logger.warn(
          `Autolock session ${session.sessionId} acquired on ${device.id} but not persisted; ` +
            `a daemon restart will not restore it: ${errorMessage(error)}`,
          error,
        );
      }
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
      throw deviceAlreadyAssignedToAnotherSessionError(device.id);
    }
    const session = device.sessionId
      ? this.pool.getSessionManager().getSession(device.sessionId)
      : null;
    if (!session) {
      return undefined;
    }
    if (!this.isOwnedAutolockSession(device, session, mcpSessionId)) {
      throw deviceAlreadyAssignedToAnotherSessionError(device.id);
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
      throw freshStartAlreadyBoundError(
        device.id,
        existingSession.sessionId,
        existingSession.ownership === "awaiting-owner",
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
    // Zero matches is not ambiguous: the connection simply holds nothing for the
    // requested platform, so the caller falls through to ordinary discovery (#11167).
    if (matches.length > 1 && !deviceId) {
      throw new ActionableError(
        `Cannot resolve requested platform/deviceId unambiguously. Candidate sessions: ${matches
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
      // A persistence failure is logged and reported by the attach; keep restoring the rest.
      await this.attachAutolockSessionToMcpSession(id, mcpSessionId, "if-absent", true);
    }
  }

  /**
   * A successful tool call that named `sessionId` explicitly (#11164): adopt it for routing only
   * when no other connected client owns it, and never flip an existing default — naming a UUID
   * is not proof of ownership, and only setActiveDevice or a restore chooses the default.
   */
  attachExplicitSessionUuidCall(
    sessionId: string,
    mcpSessionId: string | undefined,
  ): Promise<AutolockAttachOutcome> {
    return this.attachAutolockSessionToMcpSession(sessionId, mcpSessionId, "if-absent", true);
  }

  /**
   * Associate a live autolock session with a reconnected MCP client session.
   * `refuseForeignOwned` (reconnect restore, explicit-UUID calls) refuses a session another
   * connected client owns.
   */
  async attachAutolockSessionToMcpSession(
    sessionId: string,
    mcpSessionId: string | undefined,
    makeDefault: boolean | "if-absent" = true,
    refuseForeignOwned = false,
  ): Promise<AutolockAttachOutcome> {
    if (!mcpSessionId) {
      return "not-attached";
    }
    return await this.pool.withAssignmentLock(async (): Promise<AutolockAttachOutcome> => {
      const session = this.pool.getSessionManager().getSession(sessionId);
      const device = session ? this.pool.getDevice(session.assignedDevice) : undefined;
      if (
        !session ||
        !device ||
        device.sessionId !== sessionId ||
        device.autolockSessionId !== sessionId
      ) {
        return "not-attached";
      }
      if (refuseForeignOwned && this.hasMcpSessionOwner(sessionId, mcpSessionId)) {
        // The client merely named these ids: naming another connected client's autolock is
        // not proof of ownership, so never move its persisted owner or default route here
        // (#11164). setActiveDevice is the deliberate share.
        logger.warn(
          `Not attaching autolock session ${sessionId} to MCP session ${mcpSessionId}: ` +
            `another connection owns it`,
        );
        return "not-attached";
      }
      this.assertMcpSessionCanAutolockDevice(mcpSessionId, device);
      // Ownership is decided before anything is published or persisted (#11192): a connection
      // that closed while this attach was in flight already had its bindings released, so routing
      // it here would leave a dead owner that suppresses the owner-disconnect release (#10503),
      // and persisting it would let a daemon restart restore that dead mapping.
      if (refuseForeignOwned && !this.pool.recordBindOwnership(mcpSessionId, sessionId)) {
        return "not-attached";
      }
      this.recordAttachment(sessionId, mcpSessionId, makeDefault);
      return await this.persistAttachment(session, mcpSessionId);
    });
  }

  private async persistAttachment(
    session: Session,
    mcpSessionId: string,
  ): Promise<AutolockAttachOutcome> {
    try {
      const sessions = this.pool.getSessionManager();
      // Persisted stamps are wall epoch ms, shared by every process (#11162).
      await this.deviceSessionRepository.markAutolockSession(session.sessionId, {
        mcpSessionId,
        daemonSessionId: this.pool.getDaemonSessionId(),
        lastUsedAtMs: sessions.sessionClockToWall(session.lastUsedAt),
        expiresAtMs: sessions.sessionClockToWall(session.expiresAt),
      });
      return "attached";
    } catch (error) {
      // The live session is attached in memory either way; only a daemon restart loses the
      // mapping, so the caller's request still succeeds and learns the row is stale (#11129).
      logger.warn(
        `Autolock session ${session.sessionId} attached to MCP session ${mcpSessionId} but not ` +
          `persisted; a daemon restart will not restore it: ${errorMessage(error)}`,
        error,
      );
      return "attached-not-persisted";
    }
  }

  private recordAttachment(
    sessionId: string,
    mcpSessionId: string,
    makeDefault: boolean | "if-absent",
  ): void {
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

    // A derived `${base}:${label}` session counts as its base, as in the input/* ownership check.
    const sessionManager = this.pool.getSessionManager();
    const base = (uuid: string) =>
      resolveToolSelectionBaseSessionUuid(uuid, sessionManager) ?? uuid;
    if (!sessionUuid || base(device.autolockSessionId) !== base(sessionUuid)) {
      // Typed (device_owned_by_other_session) so the JUnit runner's held-device wait and the CLI
      // held-device hint recognize it (#10833).
      throw new InputDeviceOwnedError(
        "Tool call",
        deviceId,
        sessionUuid,
        "autolock is enabled, so tool calls must either come from the same MCP session that " +
          "called 'getAndroid' or 'getApple', or include the sessionUuid returned for this " +
          "device. Options: pass the sessionUuid from getAndroid or getApple that locked this " +
          "device; use getAndroid or getApple to lock a different available device; or wait for " +
          "the idle timeout to release this device.",
      );
    }
  }

  /** Whether any connected MCP client still acquired or routes to the autolock session. */
  hasMcpSessionOwner(sessionId: string, exceptMcpSessionId?: string): boolean {
    for (const [mcpSessionId, acquired] of this.mcpSessionAcquiredAutolocks) {
      if (mcpSessionId !== exceptMcpSessionId && acquired.has(sessionId)) {
        return true;
      }
    }
    for (const [mcpSessionId, mappedSessionId] of this.mcpSessionAutolockMap) {
      if (mcpSessionId !== exceptMcpSessionId && mappedSessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  /** Drop every other MCP client's hold on `sessionId`: ownership moves to `mcpSessionId` (#11107). */
  releaseMcpSessionOwnershipExcept(sessionId: string, mcpSessionId: string): void {
    for (const [otherMcpSessionId, acquired] of this.mcpSessionAcquiredAutolocks) {
      if (otherMcpSessionId !== mcpSessionId && acquired.delete(sessionId) && acquired.size === 0) {
        this.mcpSessionAcquiredAutolocks.delete(otherMcpSessionId);
      }
    }
    for (const [otherMcpSessionId, mappedSessionId] of this.mcpSessionAutolockMap) {
      if (otherMcpSessionId !== mcpSessionId && mappedSessionId === sessionId) {
        this.mcpSessionAutolockMap.delete(otherMcpSessionId);
      }
    }
  }

  releaseMcpSessionBindings(mcpSessionId: string): void {
    this.mcpSessionAcquiredAutolocks.delete(mcpSessionId);
    this.mcpSessionAutolockMap.delete(mcpSessionId);
  }
}
