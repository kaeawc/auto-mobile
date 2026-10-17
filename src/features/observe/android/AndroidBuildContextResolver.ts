/**
 * Per-device build/device provenance for observed apps (#4984): resolves the content hash and
 * version of an app, re-applies it to the current session's navigation manager, and invalidates it
 * on package changes. Extracted from `AndroidCtrlProxyClient` (#11846); behaviour is unchanged.
 */
import type { BootedDevice } from "../../../models";
import type {
  NavigationBuildContext,
  NavigationGraphManager,
} from "../../navigation/NavigationGraphManager";
import {
  createContentHashProvider,
  type ContentHashProvider,
} from "../../../utils/ContentHashProvider";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import type { A11yPackageInfoResult } from "./types";

/** Client-backed accessors resolve live state on every use, including after awaits. */
export interface AndroidBuildContextContext {
  readonly closed: boolean;
  readonly device: BootedDevice;
  readonly adb: AdbExecutor;
  readonly timer: Pick<Timer, "setTimeout">;
  getNavigationGraphManager(): Pick<
    NavigationGraphManager,
    "setBuildContext" | "clearBuildContext"
  >;
  requestPackageInfo(
    appId: string,
    options: { includePermissions: boolean },
    timeoutMs: number,
  ): Promise<A11yPackageInfoResult>;
}

export class AndroidBuildContextResolver {
  // The resolved build context per app lives on the per-device client so it survives session
  // rebinds and is re-applied to the current session's manager on every event; plus the apps whose
  // resolution is in flight, and a per-app generation bumped on package changes so a resolution
  // that started before an update can't apply a stale build.
  contentHashProvider: ContentHashProvider | null = null;
  private readonly resolvedBuildContexts = new Map<string, NavigationBuildContext>();
  private readonly buildContextInFlight = new Set<string>();
  private readonly buildContextGeneration = new Map<string, number>();

  constructor(private readonly context: AndroidBuildContextContext) {}

  /** Every app id with cached or in-flight build-context state (#4984). */
  knownApps(): string[] {
    return Array.from(
      new Set([...this.resolvedBuildContexts.keys(), ...this.buildContextInFlight]),
    );
  }

  /**
   * Ensure the build/device provenance context for an app is applied to the CURRENT
   * session's navigation manager (#4984). Non-blocking.
   *
   * Re-applies an already-resolved context on every event: the per-device client
   * outlives session rebinds, so a context resolved under session A must still be
   * set on session B's fresh manager. Otherwise it kicks off a one-in-flight
   * resolution; a nav event arriving before it lands records under the default key.
   */
  ensure(appId: string): void {
    const resolved = this.resolvedBuildContexts.get(appId);
    if (resolved) {
      this.context.getNavigationGraphManager().setBuildContext(resolved);
      return;
    }
    // No resolved context on THIS client for the app: clear it from the currently
    // selected manager so a context left by a previous binding/selection (e.g. set on
    // the global manager while unbound, then not cleared when a later package_event
    // invalidated only the bound manager) is never served as stale (#4984). Falls to
    // the default/unattributed key until (re)resolution lands. Synchronous, so it
    // takes effect before this event's write reads provenance.
    this.context.getNavigationGraphManager().clearBuildContext(appId);
    if (this.buildContextInFlight.has(appId)) {
      return;
    }
    this.buildContextInFlight.add(appId);
    const startGeneration = this.buildContextGeneration.get(appId) ?? 0;

    const resolve = async (): Promise<void> => {
      try {
        if (this.context.closed) {
          // Provenance is optional; a closed client must not start deferred device work.
          logger.debug("[CTRL_PROXY] Skipping deferred build-context resolution after close");
          return;
        }
        const info = await this.context.requestPackageInfo(
          appId,
          { includePermissions: false },
          4000,
        );
        if (this.context.closed) {
          // Missing provenance is safe; avoid a new ADB content-hash probe after release.
          logger.debug("[CTRL_PROXY] Skipping content-hash resolution after close");
          return;
        }
        // A transient package-info failure (timeout / success:false) must NOT be
        // cached as version 0 — that would attribute the whole install to a bogus
        // version until a package event. Defer; a later event retries.
        if (!info.success || typeof info.versionCode !== "number") {
          logger.debug(
            `[CTRL_PROXY] Package info unavailable for ${appId}; deferring build-context resolution`,
          );
          return;
        }
        const versionCode = info.versionCode;
        if (!this.contentHashProvider) {
          // Use the injected executor so tests with a fake adb never launch real
          // `adb`, and custom production executors aren't bypassed (#4984).
          this.contentHashProvider = createContentHashProvider(
            this.context.device,
            this.context.adb,
          );
        }
        const contentHash = await this.contentHashProvider.resolveContentHash(
          this.context.device,
          appId,
          versionCode,
        );
        // Discard if a package change invalidated this app while we were resolving —
        // applying now would stamp observations with the pre-update build's hash.
        if ((this.buildContextGeneration.get(appId) ?? 0) !== startGeneration) {
          return;
        }
        if (contentHash === null) {
          // Unresolved hash: leave the default build key; a later event retries.
          return;
        }
        const context: NavigationBuildContext = {
          appId,
          deviceId: this.context.device.deviceId,
          versionCode,
          contentHash,
        };
        this.resolvedBuildContexts.set(appId, context);
        this.context.getNavigationGraphManager().setBuildContext(context);
      } catch (error) {
        // Best-effort provenance: log at warn (unexpected failure of a diagnostic
        // path per CLAUDE.md) and let mutations fall back to the default key.
        logger.warn(`[CTRL_PROXY] Build-context resolution failed for ${appId}: ${error}`);
      } finally {
        this.buildContextInFlight.delete(appId);
      }
    };

    // Defer the resolution to a macrotask so NO work runs inline with the current
    // WebSocket message handler (#4984/#2885). resolve() would otherwise call
    // requestPackageInfo synchronously — a WS send plus a RequestManager timeout
    // timer — which reorders the barrier-tracked navigation-graph write and the
    // socket-close cache invalidation on differently-scheduled runners (macOS/Windows
    // CI). Scheduling on the injected timer keeps the event handler's barrier
    // registration synchronous and first, with the hash resolving out-of-band.
    // Fire-and-forget: resolution only sets in-memory build context (no DB write),
    // so it is NOT enlisted in the DB-write shutdown barrier.
    this.context.timer.setTimeout(() => {
      void resolve();
    }, 0);
  }

  /**
   * Invalidate all cached build/content-hash provenance for an app (#4984), so its
   * next nav event re-resolves the hash. Called on a package add/replace/remove — a
   * rebuild+reinstall (including same-versionCode/different-content) must not keep
   * recording against the old build. Bumps the generation so an in-flight resolution
   * that started before the change is discarded rather than applying a stale build.
   */
  invalidate(appId: string): void {
    this.buildContextGeneration.set(appId, (this.buildContextGeneration.get(appId) ?? 0) + 1);
    this.resolvedBuildContexts.delete(appId);
    this.contentHashProvider?.invalidate(this.context.device.deviceId, appId);
    this.context.getNavigationGraphManager().clearBuildContext(appId);
  }
}
