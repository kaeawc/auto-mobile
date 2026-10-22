import {
  MAX_OBSERVER_SESSIONS,
  observerMaySeeDeviceOwner,
} from "../../src/daemon/observerSessionRegistry";
import type { Timer } from "../../src/utils/SystemTimer";
import type {
  ObserverSessionStore,
  ObserverSession,
  ObserverRegistrationResult,
  ObserverScope,
  ObserverReleaseReason,
  ObserverDeviceOwnershipLookup,
} from "../../src/daemon/observerSessionRegistry";

/**
 * Recording fake of the observer registry. Like the real one it expires observers that stop
 * heartbeating (judged on read), caps the observer count and refuses registration once disposed;
 * the clock defaults to a private one that never advances, so tests that do not care never see
 * expiry.
 */
export class FakeObserverSessionRegistry implements ObserverSessionStore {
  private disposed = false;
  private readonly timer: Pick<Timer, "now">;
  private readonly heartbeatTimeoutMs: number;
  readonly sessions = new Map<string, ObserverSession>();
  readonly registrations: Array<{ sessionId: string; clientName: string }> = [];
  readonly heartbeats: string[] = [];
  readonly releases: Array<{ sessionId: string; reason: ObserverReleaseReason }> = [];
  registrationError?: string;

  constructor(options: { timer?: Pick<Timer, "now">; heartbeatTimeoutMs?: number } = {}) {
    this.timer = options.timer ?? { now: () => 0 };
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10000;
  }

  register(sessionId: string, clientName: string): ObserverRegistrationResult {
    this.registrations.push({ sessionId, clientName });
    this.purgeExpired();
    if (this.registrationError) {
      return { accepted: false, error: this.registrationError };
    }
    if (this.disposed) {
      return { accepted: false, error: "Observer session registry is closed" };
    }
    if (!this.sessions.has(sessionId) && this.sessions.size >= MAX_OBSERVER_SESSIONS) {
      return {
        accepted: false,
        error: `Observer session limit (${MAX_OBSERVER_SESSIONS}) reached`,
      };
    }
    const lastHeartbeat = this.timer.now();
    const expiresAtMs = lastHeartbeat + this.heartbeatTimeoutMs;
    this.sessions.set(sessionId, { sessionId, clientName, lastHeartbeat, expiresAtMs });
    return { accepted: true, heartbeatTimeoutMs: this.heartbeatTimeoutMs, expiresAtMs };
  }

  heartbeat(sessionId: string): boolean {
    this.heartbeats.push(sessionId);
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
    this.releases.push({ sessionId, reason });
    this.purgeExpired();
    return this.sessions.delete(sessionId);
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

  private purgeExpired(): void {
    const now = this.timer.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
