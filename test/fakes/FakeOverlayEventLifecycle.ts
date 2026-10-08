import type { OverlayEventLifecycle } from "../../src/server/overlayTools";

export class FakeOverlayEventLifecycle implements OverlayEventLifecycle {
  private readonly sessions = new Set<(sessionUuid: string) => void>();
  /** Unbound listeners per source (session manager); only the current source's fire. */
  private readonly unboundBySource = new Map<object, Set<(deviceId: string) => void>>();
  private unboundSource: object = {};
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
  /** Every live unbound listener, including any still attached to a replaced source. */
  getDeviceUnboundListenerCount(): number {
    return [...this.unboundBySource.values()].reduce((count, set) => count + set.size, 0);
  }
  /** Models DaemonState being reset and re-initialised with a new session manager. */
  reinitialiseDeviceUnboundSource(): void {
    this.unboundSource = {};
  }
  deviceUnboundSource(): object | undefined {
    return this.unboundAvailable ? this.unboundSource : undefined;
  }
  subscribeDeviceUnbound(listener: (deviceId: string) => void): (() => void) | undefined {
    this.unboundSubscribeCalls += 1;
    if (!this.unboundAvailable) {
      return undefined;
    }
    const source = this.unboundSource;
    const listeners = this.unboundBySource.get(source) ?? new Set();
    this.unboundBySource.set(source, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.unboundBySource.delete(source);
      }
    };
  }
  /** Unbinds through the current source; a subscription to a replaced source hears nothing. */
  unbindDevice(deviceId: string): void {
    for (const listener of [...(this.unboundBySource.get(this.unboundSource) ?? [])]) {
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
    return this.sessions.size + this.devices.size + this.getDeviceUnboundListenerCount();
  }
}
