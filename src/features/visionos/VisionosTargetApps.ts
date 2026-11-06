/** The window app each Vision Pro simulator was last told to launch; the runner automates it. */
export interface VisionosTargetApps {
  get(deviceId: string): string | undefined;
  launched(deviceId: string, bundleId: string): void;
  terminated(deviceId: string, bundleId: string): void;
}

export class InMemoryVisionosTargetApps implements VisionosTargetApps {
  private readonly apps = new Map<string, string>();

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
}

export const visionosTargetApps: VisionosTargetApps = new InMemoryVisionosTargetApps();
