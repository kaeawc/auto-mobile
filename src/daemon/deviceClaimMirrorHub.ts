import type { DeviceClaims, StoreDeviceClaimMirror } from "./deviceClaims";

/** The mirrors of one daemon, told together when a binding registry opens. */
export class DeviceClaimMirrorHub {
  private skipped = false;
  private readonly mirrors: StoreDeviceClaimMirror[] = [];

  register(mirror: StoreDeviceClaimMirror): StoreDeviceClaimMirror {
    if (this.skipped) {
      mirror.skip();
    }
    this.mirrors.push(mirror);
    return mirror;
  }

  /** Terminal until daemon restart: unknown migrations leave ownership to allocation claim files. */
  skip(): void {
    this.skipped = true;
    for (const mirror of this.mirrors) {
      mirror.skip();
    }
  }

  registryOpened(store: DeviceClaims): void {
    for (const mirror of this.mirrors) {
      mirror.reconcile(store);
    }
  }

  dispose(): void {
    for (const mirror of this.mirrors) {
      mirror.dispose();
    }
  }

  /** Resolves once every write already sent has settled. */
  async idle(): Promise<void> {
    await Promise.all(this.mirrors.map((mirror) => mirror.idle()));
  }

  async releaseOwnedClaims(store: DeviceClaims | undefined): Promise<void> {
    if (!store) {
      return;
    }
    for (const mirror of this.mirrors) {
      await mirror.releaseOwnedClaims(store);
    }
  }
}
