/** The window app each Vision Pro simulator was last told to launch; the runner automates it. */
export interface VisionosTargetApps {
  get(deviceId: string): string | undefined;
  launched(deviceId: string, bundleId: string): void;
  terminated(deviceId: string, bundleId: string): void;
  /** The app left the device: it stops being the target, and listeners hear about it. */
  uninstalled(deviceId: string, bundleId: string): void;
}

/** Tells the runner lifecycle that an app was uninstalled, so a runner automating it is dead. */
export interface VisionosAppUninstalls {
  onUninstalled(listener: (deviceId: string, bundleId: string) => void): void;
}

export class InMemoryVisionosTargetApps implements VisionosTargetApps, VisionosAppUninstalls {
  private readonly apps = new Map<string, string>();
  private readonly uninstallListeners: Array<(deviceId: string, bundleId: string) => void> = [];

  get(deviceId: string): string | undefined {
    return this.apps.get(deviceId);
  }

  launched(deviceId: string, bundleId: string): void {
    this.apps.set(deviceId, bundleId);
  }

  /** Only the current target is forgotten; stopping another app leaves it alone. */
  terminated(deviceId: string, bundleId: string): void {
    if (this.apps.get(deviceId) === bundleId) {
      this.apps.delete(deviceId);
    }
  }

  uninstalled(deviceId: string, bundleId: string): void {
    this.terminated(deviceId, bundleId);
    for (const listener of this.uninstallListeners) {
      listener(deviceId, bundleId);
    }
  }

  onUninstalled(listener: (deviceId: string, bundleId: string) => void): void {
    this.uninstallListeners.push(listener);
  }
}

export const visionosTargetApps = new InMemoryVisionosTargetApps();
