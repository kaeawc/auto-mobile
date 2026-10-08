import type { OverlayEventLifecycle } from "../../src/server/overlayTools";

export class FakeOverlayEventLifecycle implements OverlayEventLifecycle {
  private readonly sessions = new Set<(sessionUuid: string) => void>();
  private readonly unbound = new Set<(deviceId: string) => void>();
  private readonly devices = new Set<(deviceId: string) => void>();
  subscribeSessionRelease(listener: (sessionUuid: string) => void): () => void {
    this.sessions.add(listener);
    return () => {
      this.sessions.delete(listener);
    };
  }
  private unboundAvailable = true;
  private unboundSubscribeCalls = 0;
  /** Models the daemon before DaemonState initialises: unbinding cannot be observed yet. */
  setDeviceUnboundAvailable(available: boolean): void {
    this.unboundAvailable = available;
  }
  getDeviceUnboundSubscribeCalls(): number {
    return this.unboundSubscribeCalls;
  }
  getDeviceUnboundListenerCount(): number {
    return this.unbound.size;
  }
  subscribeDeviceUnbound(listener: (deviceId: string) => void): (() => void) | undefined {
    this.unboundSubscribeCalls += 1;
    if (!this.unboundAvailable) {
      return undefined;
    }
    this.unbound.add(listener);
    return () => {
      this.unbound.delete(listener);
    };
  }
  unbindDevice(deviceId: string): void {
    for (const listener of [...this.unbound]) {
      listener(deviceId);
    }
  }
  subscribeDeviceRemoval(listener: (deviceId: string) => void): () => void {
    this.devices.add(listener);
    return () => {
      this.devices.delete(listener);
    };
  }
  releaseSession(sessionUuid: string): void {
    for (const listener of [...this.sessions]) {
      listener(sessionUuid);
    }
  }
  removeDevice(deviceId: string): void {
    for (const listener of [...this.devices]) {
      listener(deviceId);
    }
  }
  getListenerCount(): number {
    return this.sessions.size + this.devices.size + this.unbound.size;
  }
}
