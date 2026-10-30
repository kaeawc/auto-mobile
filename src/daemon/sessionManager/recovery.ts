import { type DeviceSessionPersistence } from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { type Platform } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { DeviceOwnedByOtherDaemonError } from "../../models/deviceAcquisitionRefusals";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../models/managedExecutionLiveness";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
  getCliSessionIdleTimeoutMs as resolveCliSessionIdleTimeoutMs,
} from "../wire/constants";
import { clampManagedExecutionIdleTimeoutMs } from "../sessionBroker/provisioning/executionLiveness";
import { TerminalSessionError } from "../sessionErrors";
import {
  type Session,
  type SessionDeviceAssigner,
  type SessionRecoveryLiveness,
  type SessionRecoveryTarget,
  type SessionReleaseSnapshot,
  getDefaultSessionHeartbeatTimeoutMs,
} from "../sessionManager";
import {
  type ClaimedRecoverableRow,
  LEGACY_DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
  LEGACY_DEFAULT_SESSION_TIMEOUT_MS,
  type SessionLifecycleSlots,
  type PersistedSessionRecovery,
  isSessionRecoveryIdentityLossError,
  persistedHeartbeatTimeoutSource,
  persistedLivenessPolicy,
  persistedPreCliLiveness,
  persistedStableDeviceId,
  restartRecoveryDeadlineFromPersisted,
} from "./internalContracts";
import { SessionRecoveryIdentityLossError } from "./SessionRecoveryIdentityLossError";

export interface SessionRecoveryHost {
  isLapsedUnownedRestartRecovery(persisted: DeviceSession | undefined): boolean;
  admitPersistedSession(
    sessionId: string,
    persisted: DeviceSession | undefined,
  ): Promise<DeviceSession | undefined>;
  isReissuablePersistedSession(persisted: DeviceSession | undefined): boolean;
  recoverPersistedRow(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    persisted: DeviceSession | undefined,
    recovery: PersistedSessionRecovery,
  ): Promise<Session>;
  readonly daemonSessionId: string | undefined;
  readonly deviceSessionRepository: Pick<
    DeviceSessionPersistence,
    "claimRecoverableSession" | "releaseRecoverableSessionClaim"
  >;
  readPersistedSession(sessionId: string): Promise<DeviceSession | undefined>;
  terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    "setTerminalSnapshot" | "markRowClaimed" | "hasTerminalSnapshot"
  >;
  readonly sessions: Pick<Map<string, Session>, "has">;
  readonly liveDaemonSessionIds: (() => ReadonlySet<string>) | undefined;
  recoveredRowOwner(): string | null;
  sessionNow(): number;
  isNameReissueOnlyRow(persisted: DeviceSession | undefined): boolean;
  terminalizePersistedRecoveryFailure(
    sessionId: string,
    persisted: DeviceSession,
    error: Pick<SessionRecoveryIdentityLossError, "terminalReleaseReason"> &
      Partial<Pick<SessionRecoveryIdentityLossError, "ownerPid">>,
  ): Promise<void>;
  recoveryLivenessFromPersisted(persisted: DeviceSession): SessionRecoveryLiveness;
  readonly SESSION_TIMEOUT_MS: number;
}

export class SessionRecovery {
  constructor(private readonly host: SessionRecoveryHost) {}

  /** Reuse the on-demand recovery path for startup rehydration. */
  async recoverPersistedSession(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    listed: DeviceSession | undefined,
    recovery: PersistedSessionRecovery,
  ): Promise<Session> {
    if (this.host.isLapsedUnownedRestartRecovery(listed)) {
      listed = await this.host.admitPersistedSession(sessionId, listed);
    }
    const claim =
      listed && this.host.isReissuablePersistedSession(listed)
        ? await this.claimRecoverableRow(sessionId, listed)
        : undefined;
    try {
      return await this.host.recoverPersistedRow(
        sessionId,
        devicePool,
        platform,
        claim?.row ?? listed,
        recovery,
      );
    } catch (error) {
      if (claim) {
        await this.releaseFailedRecoveryClaim(sessionId, claim);
      }
      throw error;
    }
  }

  /**
   * Take ownership of a recoverable row before recovering it (#11200). Two daemons starting
   * together both list the same recoverable row; without this, both rehydrated it, and the loser
   * (whose allocation claim then failed) terminalized the row under the winner's live session. The
   * claim is a compare-and-set on the row's generation and owner, so exactly one daemon takes the
   * incarnation both read. A row a live peer already took (its owner is another live daemon) is
   * that peer's to recover. A refusal writes nothing; the returned copy carries the claimed
   * generation, which this recovery's own later writes are conditioned on.
   *
   * A compare-and-set that misses re-reads the row once and claims the current incarnation
   * (#11243): a startup listing can predate this daemon's own on-demand claim of the row, or that
   * claim's hand-back, and must not refuse the row as if a peer had taken it. A second miss is a
   * writer racing this one, and refuses.
   *
   * Resolves undefined when the daemon has no session id yet (the row is recovered as read).
   * Throws `DeviceOwnedByOtherDaemonError` (code `device_owned_by_other_daemon`), or
   * `TerminalSessionError` when the re-read finds the row terminal.
   */
  private async claimRecoverableRow(
    sessionId: string,
    listed: DeviceSession,
  ): Promise<ClaimedRecoverableRow | undefined> {
    const daemonSessionId = this.host.daemonSessionId;
    const claim = this.host.deviceSessionRepository.claimRecoverableSession.bind(
      this.host.deviceSessionRepository,
    );
    if (daemonSessionId === undefined) {
      return undefined;
    }
    const claimed = await this.tryClaimRecoverableRow(sessionId, listed, claim, daemonSessionId);
    if (claimed) {
      return claimed;
    }
    let current = await this.host.readPersistedSession(sessionId);
    if (this.host.isLapsedUnownedRestartRecovery(current)) {
      current = await this.host.admitPersistedSession(sessionId, current);
    }
    const terminalRelease = current && this.host.terminalReleaseFromPersisted(sessionId, current);
    if (terminalRelease) {
      this.host.sessionSlots.setTerminalSnapshot(sessionId, terminalRelease);
      throw new TerminalSessionError(sessionId, terminalRelease);
    }
    if (current && this.host.isReissuablePersistedSession(current)) {
      const reclaimed = await this.tryClaimRecoverableRow(
        sessionId,
        current,
        claim,
        daemonSessionId,
      );
      if (reclaimed) {
        return reclaimed;
      }
    }
    throw this.recoverableRowClaimRefusal(sessionId, current ?? listed);
  }

  /** One compare-and-set against `row`; undefined when the row is no longer that incarnation. */
  private async tryClaimRecoverableRow(
    sessionId: string,
    row: DeviceSession,
    claim: DeviceSessionPersistence["claimRecoverableSession"],
    daemonSessionId: string,
  ): Promise<ClaimedRecoverableRow | undefined> {
    const owner = row.daemon_session_id ?? null;
    if (owner !== null && owner !== daemonSessionId && this.isLiveDaemonSession(owner)) {
      throw this.recoverableRowClaimRefusal(sessionId, row);
    }
    const generation = await claim(
      sessionId,
      { rowGeneration: row.stable_identity_generation ?? 0, daemonSessionId: owner },
      daemonSessionId,
    );
    if (generation === undefined) {
      return undefined;
    }
    const claimed = {
      ...row,
      stable_identity_generation: generation,
      daemon_session_id: daemonSessionId,
    };
    this.host.sessionSlots.markRowClaimed(claimed);
    return {
      row: claimed,
      // This daemon's own stale claim is handed back unowned, so a peer can take it.
      previousOwner: owner === daemonSessionId ? null : owner,
    };
  }

  private recoverableRowClaimRefusal(sessionId: string, row: DeviceSession): Error {
    const owner = row.daemon_session_id ?? null;
    if (owner !== null && owner !== this.host.daemonSessionId) {
      logger.info(
        `[SessionManager] Not recovering session ${sessionId}: another AutoMobile daemon ` +
          `(${owner}) took its row first`,
      );
      return new DeviceOwnedByOtherDaemonError(row.device_id, undefined);
    }
    logger.info(
      `[SessionManager] Not recovering session ${sessionId}: its row changed during recovery ` +
        `(now ${row.status}, ${row.release_reason ?? "no release reason"})`,
    );
    return new ActionableError(
      `Session ${sessionId} is no longer recoverable: its persisted row changed during recovery. ` +
        "Retry, or acquire a new device with getAndroid or getApple.",
    );
  }

  /**
   * A recovery that failed after claiming its row, without recovering or terminalizing it
   * (#11243): its caller cancelled or ran out of time, the requested platform did not match, or
   * the device assignment failed. Hand the claim back, so the row is not left owned by a live
   * daemon that will not retry it — which a peer, and this daemon's own startup, would refuse
   * until this daemon exited or the row expired. Releasing rather than retrying here keeps the
   * retry with whoever asks next (the session's owner reconnecting, or a peer's startup), which
   * already re-runs the full admission; a retry loop inside the daemon would recover a session no
   * caller is waiting for. The hand-back is conditioned on the claimed incarnation, so it is a
   * no-op once the recovery's own upsert, a terminal release, or a peer changed the row.
   */
  private async releaseFailedRecoveryClaim(
    sessionId: string,
    claim: ClaimedRecoverableRow,
  ): Promise<void> {
    const release = this.host.deviceSessionRepository.releaseRecoverableSessionClaim.bind(
      this.host.deviceSessionRepository,
    );
    if (
      this.host.sessions.has(sessionId) ||
      this.host.sessionSlots.hasTerminalSnapshot(sessionId)
    ) {
      return;
    }
    try {
      const released = await release(
        sessionId,
        {
          rowGeneration: claim.row.stable_identity_generation ?? 0,
          daemonSessionId: claim.row.daemon_session_id ?? null,
        },
        claim.previousOwner,
      );
      if (released) {
        logger.info(
          `[SessionManager] Recovery of session ${sessionId} failed; handed its row back to ` +
            `${claim.previousOwner ?? "no owner"} so another recovery can take it`,
        );
      }
    } catch (error) {
      // The recovery's own error is what the caller sees; the row stays claimed until this daemon
      // exits or the row expires, as before #11243.
      logger.warn(
        `[SessionManager] Failed to hand back the claim on session ${sessionId}: ` +
          errorMessage(error),
        error,
      );
    }
  }

  /** Whether `daemonSessionId` names a live daemon, by the attached provider (#11200). */
  isLiveDaemonSession(daemonSessionId: string): boolean {
    if (!this.host.liveDaemonSessionIds) {
      return false;
    }
    try {
      return this.host.liveDaemonSessionIds().has(daemonSessionId);
    } catch (error) {
      // The row compare-and-set still keeps two concurrent recoveries apart; only a row a live
      // peer took before this daemon read it is left to that check.
      logger.warn(
        `[SessionManager] Cannot list live daemons to check row owner ${daemonSessionId}: ` +
          errorMessage(error),
        error,
      );
      return false;
    }
  }

  recoverySessionFields(
    persisted: DeviceSession | undefined,
  ): Pick<
    Session,
    "persistenceMetadata" | "livenessOwnerToken" | "livenessOwnershipClaims" | "lastOwnerHeartbeat"
  > {
    if (!persisted) {
      return {};
    }
    return {
      persistenceMetadata: {
        source: persisted.source,
        autolockEnabled: persisted.autolock_enabled === 1,
        mcpSessionId: persisted.mcp_session_id,
        // The persisted owner is the dead daemon; this daemon now owns the row (#11114).
        daemonSessionId: this.host.recoveredRowOwner(),
      },
      ...(persisted.liveness_owner_token
        ? {
            livenessOwnerToken: persisted.liveness_owner_token,
            livenessOwnershipClaims: new Set([persisted.liveness_owner_token]),
            lastOwnerHeartbeat: this.host.sessionNow(),
          }
        : {}),
    };
  }

  /**
   * A recovery conflict is terminal for this UUID. Keep the fencing work out
   * of createUnseenSession so ordinary allocation stays easy to audit.
   */
  async assignUnseenSessionToDevicePool(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    recoveryTarget: SessionRecoveryTarget | undefined,
    persisted: DeviceSession | undefined,
  ): Promise<void> {
    try {
      await devicePool.assignDeviceToSession(sessionId, platform, recoveryTarget);
    } catch (error) {
      // Preserve terminal recovery fencing while surfacing the explicit-bind refusal itself.
      logger.debug(
        `[SessionManager] Recovery assignment refused for ${sessionId}: ${errorMessage(error)}`,
      );
      const recoveryError =
        error instanceof DeviceOwnedByOtherDaemonError && recoveryTarget
          ? new SessionRecoveryIdentityLossError(
              sessionId,
              recoveryTarget,
              "owned-by-other-daemon",
              {
                deviceId: error.deviceId,
                ownerPid: error.ownerPid,
              },
            )
          : error;
      if (
        !persisted ||
        !isSessionRecoveryIdentityLossError(recoveryError) ||
        recoveryError.sessionUuid !== sessionId
      ) {
        throw error;
      }
      if (!this.host.isNameReissueOnlyRow(persisted)) {
        await this.host.terminalizePersistedRecoveryFailure(sessionId, persisted, recoveryError);
        throw error;
      }
      // #11418: a re-issued plan session has no device identity to protect. Its old device being
      // taken or gone is not a loss; the UUID stays usable on whatever ordinary allocation grants.
      logger.info(
        `[SessionManager] Re-issuing session ${sessionId} on another device: its previous device ` +
          `${persisted.device_id} cannot be reused (${recoveryError.reason})`,
      );
      await devicePool.assignDeviceToSession(sessionId, platform ?? persisted.platform);
    }
  }

  async recoveryTargetFromPersisted(
    sessionId: string,
    persisted: DeviceSession | undefined,
    requestedPlatform: Platform | undefined,
    callerInFlight: boolean,
  ): Promise<SessionRecoveryTarget | undefined> {
    // A recovery claimed inside the window keeps its target; its own wait decides when to end.
    if (!persisted || !this.host.isReissuablePersistedSession(persisted)) {
      return undefined;
    }
    const stableDeviceId = persistedStableDeviceId(persisted);
    if (!stableDeviceId && this.host.isNameReissueOnlyRow(persisted)) {
      // Nothing to prefer: the re-issue is an ordinary allocation (#11418).
      return undefined;
    }
    if (!stableDeviceId) {
      await this.host.terminalizePersistedRecoveryFailure(sessionId, persisted, {
        terminalReleaseReason: "identity-recovery-identity-continuity-lost",
      });
      throw new ActionableError(
        `Cannot safely recover session ${sessionId}: its persisted device identity is unavailable. ` +
          "Acquire a new device with getAndroid or getApple.",
      );
    }
    if (requestedPlatform && requestedPlatform !== persisted.platform) {
      throw new ActionableError(
        `Cannot safely recover session ${sessionId}: requested platform ${requestedPlatform} ` +
          `does not match persisted platform ${persisted.platform}. ` +
          "Acquire a new device with getAndroid or getApple.",
      );
    }
    return {
      platform: persisted.platform,
      stableDeviceId,
      deviceId: persisted.device_id,
      restartRecoveryDeadlineMs: restartRecoveryDeadlineFromPersisted(persisted, callerInFlight),
      liveness: this.host.recoveryLivenessFromPersisted(persisted),
      persistenceMetadata: {
        source: persisted.source,
        autolockEnabled: persisted.autolock_enabled === 1,
        mcpSessionId: persisted.mcp_session_id,
        daemonSessionId: this.host.recoveredRowOwner(),
      },
      ...(persisted.platform === "android"
        ? { androidEmulator: isAndroidEmulatorSerial(persisted.device_id) }
        : {}),
    };
  }

  /**
   * Rebuild the liveness contract from the persisted row. Rows written before
   * the liveness columns existed fall back to the strict default contract;
   * autolock metadata alone is not proof that a client declared CLI liveness.
   */
  recoveryLivenessFromPersisted(persisted: DeviceSession): SessionRecoveryLiveness {
    const heartbeatTimeoutSource = persistedHeartbeatTimeoutSource(
      persisted.heartbeat_timeout_source,
    );
    const livenessPolicy = persistedLivenessPolicy(persisted.liveness_policy);
    const persistedPreCli = persistedPreCliLiveness(persisted);
    const preCliLiveness = persistedPreCli && {
      ...persistedPreCli,
      heartbeatTimeoutMs: this.currentDefaultLease(
        persistedPreCli.heartbeatTimeoutMs,
        persistedPreCli.heartbeatTimeoutSource,
      ),
      sessionTimeoutMs: this.currentDefaultIdleWindow(persistedPreCli.sessionTimeoutMs),
    };
    if (livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY) {
      // The declared window is the execution's own, not a default to follow: 30 minutes (the
      // legacy default `currentDefaultIdleWindow` rewrites) is a valid managed window (#11176).
      return {
        sessionTimeoutMs: clampManagedExecutionIdleTimeoutMs(persisted.session_timeout_ms),
        heartbeatTimeoutMs: this.currentDefaultLease(
          persisted.heartbeat_timeout_ms,
          heartbeatTimeoutSource,
        ),
        heartbeatTimeoutSource,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        livenessPolicy,
      };
    }
    const sessionTimeoutMs = this.currentDefaultIdleWindow(persisted.session_timeout_ms);
    if (livenessPolicy === "cli-idle") {
      // A CLI session's heartbeat timeout is its idle timeout, whatever the stored source says.
      const cliIdleTimeoutMs =
        persisted.heartbeat_timeout_ms === LEGACY_DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS
          ? Math.min(resolveCliSessionIdleTimeoutMs(), MAX_CLI_SESSION_IDLE_TIMEOUT_MS)
          : persisted.heartbeat_timeout_ms;
      return {
        sessionTimeoutMs: Math.max(sessionTimeoutMs, cliIdleTimeoutMs),
        heartbeatTimeoutMs: cliIdleTimeoutMs,
        heartbeatTimeoutSource,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        livenessPolicy,
        ...(preCliLiveness ? { preCliLiveness } : {}),
      };
    }
    return {
      sessionTimeoutMs,
      heartbeatTimeoutMs: this.currentDefaultLease(
        persisted.heartbeat_timeout_ms,
        heartbeatTimeoutSource,
      ),
      heartbeatTimeoutSource,
      hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
      livenessPolicy,
      ...(preCliLiveness ? { preCliLiveness } : {}),
    };
  }

  /**
   * A recovered session's lease: one this daemon (or an older one) chose by default follows the
   * current default, so an upgrade does not leave a pre-upgrade session on the old lease for its
   * whole life. An explicitly requested lease is kept.
   */
  private currentDefaultLease(heartbeatTimeoutMs: number, source: "default" | "custom"): number {
    return source === "default" ? getDefaultSessionHeartbeatTimeoutMs() : heartbeatTimeoutMs;
  }

  /**
   * A recovered session's idle window. The stored value has no source column, so a row holding
   * exactly the pre-2026-10-08 default (30 min) is treated as defaulted and follows the current
   * idle window; any other value was requested and is kept.
   */
  private currentDefaultIdleWindow(sessionTimeoutMs: number): number {
    return sessionTimeoutMs === LEGACY_DEFAULT_SESSION_TIMEOUT_MS
      ? this.host.SESSION_TIMEOUT_MS
      : sessionTimeoutMs;
  }
}
