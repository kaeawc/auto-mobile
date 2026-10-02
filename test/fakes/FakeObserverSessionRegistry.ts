import { observerMaySeeDeviceOwner } from "../../src/daemon/observerSessionRegistry";
import type {
  ObserverSessionStore,
  ObserverSession,
  ObserverRegistrationResult,
  ObserverScope,
  ObserverReleaseReason,
  ObserverDeviceOwnershipLookup,
} from "../../src/daemon/observerSessionRegistry";

export class FakeObserverSessionRegistry implements ObserverSessionStore {
  readonly sessions = new Map<string, ObserverSession>();
  readonly registrations: Array<{ sessionId: string; clientName: string }> = [];
  readonly heartbeats: string[] = [];
  readonly releases: Array<{ sessionId: string; reason: ObserverReleaseReason }> = [];
  registrationError?: string;

  register(sessionId: string, clientName: string): ObserverRegistrationResult {
    this.registrations.push({ sessionId, clientName });
    if (this.registrationError) {
      return { accepted: false, error: this.registrationError };
    }
    this.sessions.set(sessionId, { sessionId, clientName, lastHeartbeat: 0, expiresAtMs: 10000 });
    return { accepted: true, heartbeatTimeoutMs: 10000, expiresAtMs: 10000 };
  }

  heartbeat(sessionId: string): boolean {
    this.heartbeats.push(sessionId);
    return this.sessions.has(sessionId);
  }

  release(sessionId: string, reason: ObserverReleaseReason = "explicit-release"): boolean {
    this.releases.push({ sessionId, reason });
    return this.sessions.delete(sessionId);
  }

  list(): ObserverSession[] {
    return Array.from(this.sessions.values());
  }
  resolveObserverScope(sessionUuid: string): ObserverScope {
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
    this.sessions.clear();
  }
}
