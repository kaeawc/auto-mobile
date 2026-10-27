import type { DeviceClaims, StoreDeviceClaimMirror } from "./deviceClaims";

/** The mirrors of one daemon, told together when a binding registry opens. */
export class DeviceClaimMirrorHub {
  private readonly mirrors: StoreDeviceClaimMirror[] = [];

  register(mirror: StoreDeviceClaimMirror): StoreDeviceClaimMirror {
    this.mirrors.push(mirror);
    return mirror;
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
}
