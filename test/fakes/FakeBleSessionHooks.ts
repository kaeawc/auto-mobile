import type { SessionManager } from "../../src/daemon/sessionManager";

export class FakeBleSessionHooks implements Pick<
  SessionManager,
  "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
> {
  release?: Parameters<SessionManager["onSessionRelease"]>[0];
  unbound?: Parameters<SessionManager["onSessionDeviceUnbound"]>[0];
  readonly pending: { deviceId: string; cleanup: Promise<unknown> }[] = [];
  onSessionRelease(listener: Parameters<SessionManager["onSessionRelease"]>[0]): void {
    this.release = listener;
  }
  onSessionDeviceUnbound(listener: Parameters<SessionManager["onSessionDeviceUnbound"]>[0]): void {
    this.unbound = listener;
  }
  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>): void {
    this.pending.push({ deviceId, cleanup });
  }

  releaseOwner(
    owner: string,
    options: { upgradeOnly?: boolean; deviceIdentityReplaced?: boolean } = {},
  ): void {
    this.release?.(owner, "emulator-5554", "released", {
      ...options,
      snapshot: {
        sessionId: owner,
        deviceId: "emulator-5554",
        releaseReason: "released",
        releasedAtMs: 0,
        terminal: true,
        heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 0, ageMs: 0 },
      },
    });
  }
}
