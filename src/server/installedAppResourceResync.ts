import { ResourceRegistry } from "./resourceRegistry";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

/**
 * Freshness gate for re-syncing per-device app resources on resources/list. Registration is
 * once-per-process (#13068), so devices booted or removed outside AutoMobile reach the roster
 * only through this gate: at most one sync per window, concurrent callers share one run.
 */
export const INSTALLED_APP_RESOURCE_RESYNC_TTL_MS = 5000;

export class InstalledAppResourceResyncGate {
  private lastSyncAt: number | undefined;
  private inFlight: Promise<void> | undefined;

  resyncIfStale(sync: () => Promise<void>, timer: Timer = defaultTimer): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    if (
      this.lastSyncAt !== undefined &&
      timer.now() - this.lastSyncAt < INSTALLED_APP_RESOURCE_RESYNC_TTL_MS
    ) {
      return Promise.resolve();
    }
    // Stamp on start so a failing or slow discovery is not retried by every list.
    this.lastSyncAt = timer.now();
    const run = sync().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  reset(): void {
    this.lastSyncAt = undefined;
    this.inFlight = undefined;
  }
}

export const installedAppResourceResyncGate = new InstalledAppResourceResyncGate();

/** Make every resources/list reply re-sync per-device app resources when stale. */
export function registerInstalledAppResourceListRefresher(
  sync: () => Promise<void>,
  timer: Timer = defaultTimer,
): void {
  ResourceRegistry.registerListRefresher("installed-apps", () =>
    installedAppResourceResyncGate.resyncIfStale(sync, timer),
  );
}
