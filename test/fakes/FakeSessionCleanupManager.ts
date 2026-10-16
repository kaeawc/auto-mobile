import type { SessionManager } from "../../src/daemon/sessionManager";

/** The narrow SessionManager surface the per-feature session-cleanup registrars consume. */
export type SessionCleanupSurface = Pick<
  SessionManager,
  | "onSessionRelease"
  | "onSessionDeviceUnbound"
  | "registerPendingDeviceCleanup"
  | "registerAcquisitionDeviceCleanup"
  | "getSessionForDevice"
>;

type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];
type UnboundCallback = Parameters<SessionManager["onSessionDeviceUnbound"]>[0];
type ReleaseReason = Parameters<ReleaseCallback>[2];
/** The full bound the real manager accepts: a trusted numeric cap or a manager-capped descriptor. */
export type PendingCleanupBound = Parameters<SessionManager["registerPendingDeviceCleanup"]>[2];
type AcquisitionCleanupCap = Parameters<SessionManager["registerAcquisitionDeviceCleanup"]>[2];

export interface FakeSessionCleanupManagerOptions {
  /** Reason reported to release callbacks; defaults to "explicit-release". */
  releaseReason?: ReleaseReason;
  /** Whether the reported release is terminal; defaults to true. */
  terminal?: boolean;
}

interface RecordedPendingCleanup {
  deviceId: string;
  cleanup: Promise<unknown>;
  bound?: PendingCleanupBound;
}

interface RecordedAcquisitionCleanup {
  deviceId: string;
  cleanup: Promise<unknown>;
  capMs?: AcquisitionCleanupCap;
}

/**
 * Records the release/unbind callbacks and device cleanups that session-cleanup
 * registrars attach, and lets a test fire them without a real SessionManager.
 */
export class FakeSessionCleanupManager implements SessionCleanupSurface {
  /** deviceId -> holding sessionId, for `getSessionForDevice`. */
  holders = new Map<string, string>();
  releaseCallbacks: ReleaseCallback[] = [];
  unboundCallbacks: UnboundCallback[] = [];
  pendingCleanups: RecordedPendingCleanup[] = [];
  acquisitionCleanups: RecordedAcquisitionCleanup[] = [];

  private readonly releaseReason: ReleaseReason;
  private readonly terminal: boolean;

  constructor(options: FakeSessionCleanupManagerOptions = {}) {
    this.releaseReason = options.releaseReason ?? "explicit-release";
    this.terminal = options.terminal ?? true;
  }

  getSessionForDevice(deviceId: string): string | null {
    return this.holders.get(deviceId) ?? null;
  }

  onSessionRelease(callback: ReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }

  onSessionDeviceUnbound(callback: UnboundCallback): void {
    this.unboundCallbacks.push(callback);
  }

  registerPendingDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    bound?: PendingCleanupBound,
  ): void {
    this.pendingCleanups.push({ deviceId, cleanup, bound });
  }

  registerAcquisitionDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    capMs?: AcquisitionCleanupCap,
  ): void {
    this.acquisitionCleanups.push({ deviceId, cleanup, capMs });
  }

  release(
    sessionId: string,
    deviceId: string,
    upgradeOnly = false,
    deviceIdentityReplaced = false,
  ): void {
    for (const callback of this.releaseCallbacks) {
      callback(
        sessionId,
        deviceId,
        this.releaseReason,
        {
          sessionId,
          deviceId,
          releaseReason: this.releaseReason,
          releasedAtMs: 0,
          terminal: this.terminal,
          heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
        },
        { upgradeOnly, deviceIdentityReplaced },
      );
    }
  }

  unbound(sessionId: string, deviceId: string, deviceIdentityReplaced = false): void {
    for (const callback of this.unboundCallbacks) {
      callback(sessionId, deviceId, { deviceIdentityReplaced });
    }
  }

  /** Alias of `unbound` for suites that never replace the device identity. */
  unbind(sessionId: string, deviceId: string): void {
    this.unbound(sessionId, deviceId);
  }

  async settle(): Promise<void> {
    await Promise.all(
      [...this.pendingCleanups, ...this.acquisitionCleanups].map((entry) => entry.cleanup),
    );
  }
}
