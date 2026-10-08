import { logger } from "../utils/logger";
import { getDefaultSessionHeartbeatTimeoutMs } from "./sessionManager";
import { SUSPECT_GRACE_MS } from "./sessionLivenessWindows";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

export const MAX_OBSERVER_SESSIONS = 32;
export const MAX_OBSERVER_CLIENT_NAME_LENGTH = 128;
export const MAX_OBSERVER_SESSION_ID_LENGTH = 128;

export interface ObserverSession {
  sessionId: string;
  clientName: string;
  lastHeartbeat: number;
  expiresAtMs: number;
}

export interface ObserverRegistration {
  accepted: true;
  heartbeatTimeoutMs: number;
  expiresAtMs: number;
}

export type ObserverRegistrationResult = ObserverRegistration | { accepted: false; error: string };
export type ObserverScope = { kind: "denied" } | { kind: "unowned-devices-only" };
export type ObserverReleaseReason = "explicit-release" | "heartbeat-timeout" | "promotion";

export interface ObserverSessionStore {
  register(sessionId: string, clientName: string): ObserverRegistrationResult;
  heartbeat(sessionId: string): boolean;
  release(sessionId: string, reason?: ObserverReleaseReason): boolean;
  list(): ObserverSession[];
  resolveObserverScope(sessionUuid: string): ObserverScope;
  canObserveDevice(
    sessionUuid: string,
    deviceId: string,
    ownership: ObserverDeviceOwnershipLookup,
  ): boolean;
  dispose(): void;
}

export interface ObserverDeviceOwnershipLookup {
  getSessionForDevice(deviceId: string): string | null;
}

/** Pending owner confirmation: registration alone grants only unowned-device reads. */
export function observerMaySeeDeviceOwner(ownerSessionId: string | null): boolean {
  return ownerSessionId === null;
}

/** Separate from device sessions and persistence; never used by device-tool admission. */
export class ObserverSessionRegistry implements ObserverSessionStore {
  private readonly sessions = new Map<string, ObserverSession>();
  private disposed = false;

  constructor(
    private readonly timer: Timer = defaultTimer,
    // An observer gets the same no-heartbeat budget as a session owner: the lease plus the
    // suspect grace, so one late heartbeat at the 2 s client cadence never expires it.
    private readonly heartbeatTimeoutMs = getDefaultSessionHeartbeatTimeoutMs() + SUSPECT_GRACE_MS,
  ) {}

  register(sessionId: string, clientName: string): ObserverRegistrationResult {
    this.purgeExpired();
    if (this.disposed) {
      return {
        accepted: false,
        error: "Observer session registry is closed; reconnect to the daemon",
      };
    }
    if (!this.sessions.has(sessionId) && this.sessions.size >= MAX_OBSERVER_SESSIONS) {
      return {
        accepted: false,
        error: `Observer session limit (${MAX_OBSERVER_SESSIONS}) reached; release a session or wait for heartbeat expiry before retrying`,
      };
    }
    const lastHeartbeat = this.timer.now();
    const expiresAtMs = lastHeartbeat + this.heartbeatTimeoutMs;
    this.sessions.set(sessionId, { sessionId, clientName, lastHeartbeat, expiresAtMs });
    logger.debug(`Registered observer session ${sessionId} (${clientName})`);
    return { accepted: true, heartbeatTimeoutMs: this.heartbeatTimeoutMs, expiresAtMs };
  }

  heartbeat(sessionId: string): boolean {
    this.purgeExpired();
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.lastHeartbeat = this.timer.now();
    session.expiresAtMs = session.lastHeartbeat + this.heartbeatTimeoutMs;
    return true;
  }

  release(sessionId: string, reason: ObserverReleaseReason = "explicit-release"): boolean {
    this.purgeExpired();
    return this.remove(sessionId, reason);
  }

  list(): ObserverSession[] {
    this.purgeExpired();
    return Array.from(this.sessions.values(), (session) => ({ ...session }));
  }

  resolveObserverScope(sessionUuid: string): ObserverScope {
    this.purgeExpired();
    return this.sessions.has(sessionUuid) ? { kind: "unowned-devices-only" } : { kind: "denied" };
  }

  canObserveDevice(
    sessionUuid: string,
    deviceId: string,
    ownership: ObserverDeviceOwnershipLookup,
  ): boolean {
    return (
      this.resolveObserverScope(sessionUuid).kind !== "denied" &&
      observerMaySeeDeviceOwner(ownership.getSessionForDevice(deviceId))
    );
  }

  dispose(): void {
    this.disposed = true;
    this.sessions.clear();
  }

  private remove(sessionId: string, reason: ObserverReleaseReason): boolean {
    const removed = this.sessions.delete(sessionId);
    if (removed) {
      logger.debug(`Removed observer session ${sessionId}: ${reason}`);
    }
    return removed;
  }

  /** Lazy expiry uses the injected clock; no timer can retain the daemon or leak on shutdown. */
  private purgeExpired(): void {
    const now = this.timer.now();
    for (const session of this.sessions.values()) {
      if (session.expiresAtMs <= now) {
        this.remove(session.sessionId, "heartbeat-timeout");
      }
    }
  }
}
