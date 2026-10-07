/**
 * Host-side store for real per-frame metrics pushed by the in-app
 * `auto-mobile-sdk` frame collectors through CtrlProxy
 * (`frame_metrics_event`, issue #5076).
 *
 * `PerformanceMonitor.sampleAndroidDevice` prefers a *fresh* SDK sample over the
 * host-side `dumpsys gfxinfo` scrape. iOS uses the same store keyed by bundle id,
 * with null frame readings when there is no fresh SDK sample. An SDK app reports
 * its real app-process fps/frame-time/jank in `perfSnapshot`. Android falls back
 * to dumpsys when no fresh SDK sample exists (non-SDK app, or a quiet feed). Keyed by `${deviceId}:${packageName}` like
 * `RecompositionTracker`.
 */
export interface SdkFrameSample {
  fps: number | null;
  frameTimeMs: number | null;
  jankFrames: number | null;
  /** Host receipt time (ms), used for the freshness check. */
  receivedAt: number;
}

export class SdkFrameMetricsStore {
  private readonly byKey = new Map<string, SdkFrameSample>();

  private static key(deviceId: string, packageName: string): string {
    return `${deviceId}:${packageName}`;
  }

  /** Record the latest SDK frame sample for a device/package. */
  ingest(deviceId: string, packageName: string, sample: SdkFrameSample): void {
    this.byKey.set(SdkFrameMetricsStore.key(deviceId, packageName), sample);
  }

  /**
   * Return the latest SDK sample for this device/package if it arrived within
   * `ttlMs` of `now`, else null. The TTL guards against a stale feed (the SDK
   * broadcasts ~1/s, so a sample older than a couple seconds means the app
   * stopped reporting: Android falls back to dumpsys, iOS reports no frames).
   */
  getFresh(
    deviceId: string,
    packageName: string,
    now: number,
    ttlMs: number,
  ): SdkFrameSample | null {
    const sample = this.byKey.get(SdkFrameMetricsStore.key(deviceId, packageName));
    if (!sample || now - sample.receivedAt > ttlMs) {
      return null;
    }
    return sample;
  }

  /** Drop retained samples for a device (all packages). */
  clear(deviceId: string): void {
    const prefix = `${deviceId}:`;
    for (const k of this.byKey.keys()) {
      if (k.startsWith(prefix)) {
        this.byKey.delete(k);
      }
    }
  }
}

let singleton: SdkFrameMetricsStore | null = null;

/** Process-wide store shared by the CtrlProxy client (writer) and sampler (reader). */
export function getSdkFrameMetricsStore(): SdkFrameMetricsStore {
  if (singleton === null) {
    singleton = new SdkFrameMetricsStore();
  }
  return singleton;
}
