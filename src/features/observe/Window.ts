import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ActiveWindowInfo } from "../../models/ActiveWindowInfo";
import { logger } from "../../utils/logger";
import { NodeCryptoService } from "../../utils/crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { BootedDevice } from "../../models";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { getTempDir, TEMP_SUBDIRS } from "../../utils/tempDir";
import type { Window as WindowInterface } from "./interfaces/Window";
import { combineWithAmbientAbort } from "../../utils/AbortContext";

// AdbExecutor extended with optional AdbClient-specific methods. Both the
// deadline (timeoutMs) and the cancellation signal are forwarded so the
// getActive read cannot outlive the caller budget nor survive an abort.
type ExtendedAdbExecutor = AdbExecutor & {
  getAndroidApiLevel?: (timeoutMs?: number, signal?: AbortSignal) => Promise<number | null>;
};

/**
 * Options bounding a single {@link Window.getActive} read. Both are threaded
 * into EVERY underlying device command (the initial `dumpsys window windows`,
 * the API-level probe, and the API-27 `dumpsys window` legacy fallback) so no
 * sub-read can outlive `timeoutMs` or continue past `signal`'s abort.
 */
export interface GetActiveOptions {
  /** Cancellation signal; combined with the ambient request signal per read. */
  signal?: AbortSignal;
  /** Per-read deadline in ms. Defaults to {@link DEFAULT_GET_ACTIVE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Default per-read deadline for the `getActive` device commands when the caller
 * supplies no budget. Keeps every dumpsys read bounded rather than unbounded, so
 * a wedged adb cannot hang the foreground verification indefinitely.
 */
export const DEFAULT_GET_ACTIVE_TIMEOUT_MS = 5000;

export class Window implements WindowInterface {
  private adb: ExtendedAdbExecutor;
  private cachedActiveWindow: ActiveWindowInfo | null = null;
  private readonly device: BootedDevice;
  private cacheDir: string = getTempDir(TEMP_SUBDIRS.WINDOW);

  /**
   * Create a Window instance
   * @param device - Device to run ADB commands against
   * @param adbFactory - Factory for creating AdbClient instances
   */
  constructor(device: BootedDevice, adbFactory: AdbClientFactory = defaultAdbClientFactory) {
    this.adb = adbFactory.create(device);
    this.device = device;
  }

  /**
   * Get the cache file path based on device ID
   */
  private getCacheFilePath(): string {
    const deviceHash = NodeCryptoService.generateCacheKey(this.device.deviceId);
    return path.join(this.cacheDir, deviceHash);
  }

  public getDeviceId(): string {
    return this.device.deviceId;
  }

  /**
   * Write cache to disk
   */
  private async writeCacheToDisk(activeWindow: ActiveWindowInfo): Promise<void> {
    const filePath = this.getCacheFilePath();
    if (!filePath) {
      logger.info("[WINDOW] No device ID, skipping disk cache write");
      return;
    }

    try {
      // Ensure directory exists
      await fs.mkdir(this.cacheDir, { recursive: true });

      // Write cache to disk
      await fs.writeFile(filePath, JSON.stringify(activeWindow), "utf-8");
      logger.debug(`Wrote active window cache to disk: ${filePath}`);
    } catch (err) {
      logger.error(`Failed to write cache to disk: ${err}`);
    }
  }

  /**
   * Read cache from disk
   */
  private async readCacheFromDisk(): Promise<ActiveWindowInfo | null> {
    const filePath = this.getCacheFilePath();
    if (!filePath) {
      logger.info("[WINDOW] No device ID, skipping disk cache read");
      return null;
    }

    try {
      const data = await fs.readFile(filePath, "utf-8");
      const activeWindow = JSON.parse(data) as ActiveWindowInfo;
      logger.debug(`Read active window cache from disk: ${filePath}`);
      return activeWindow;
    } catch (err) {
      // File doesn't exist or other error - this is normal
      logger.debug(`No disk cache found or error reading: ${err}`);
      return null;
    }
  }

  /**
   * Set cached active window from external source (e.g., UI stability waiting)
   */
  public async setCachedActiveWindow(activeWindow: ActiveWindowInfo): Promise<void> {
    this.cachedActiveWindow = activeWindow;
    await this.writeCacheToDisk(activeWindow);
    logger.info("[WINDOW] Cached active window from external source");
  }

  /**
   * Clear the cached active window
   */
  public async clearCache(): Promise<void> {
    this.cachedActiveWindow = null;

    // Also remove from disk
    const filePath = this.getCacheFilePath();
    if (filePath) {
      try {
        await fs.unlink(filePath);
        logger.info("[WINDOW] Cleared cached active window from disk");
      } catch (err) {
        // File might not exist, which is fine
        logger.debug(`Could not remove disk cache: ${err}`);
      }
    }

    logger.info("[WINDOW] Cleared cached active window");
  }

  async getCachedActiveWindow(): Promise<ActiveWindowInfo | null> {
    if (!this.cachedActiveWindow) {
      logger.info("[WINDOW] Using disk cached active window");
      const diskCache = await this.readCacheFromDisk();
      if (diskCache) {
        this.cachedActiveWindow = diskCache;
        logger.info("[WINDOW] Using disk cached active window");
        return diskCache;
      }
    }
    return this.cachedActiveWindow;
  }

  /**
   * Get information about the active window
   * @param forceRefresh - Force refresh the cache (default: false)
   * @param perf - Optional performance tracker
   * @returns Promise with active window information
   */
  async getActive(
    forceRefresh: boolean = false,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    options: GetActiveOptions = {},
  ): Promise<ActiveWindowInfo> {
    // Return cached value if available and not forcing refresh
    if (!forceRefresh && this.cachedActiveWindow) {
      logger.info("[WINDOW] Using memory cached active window");
      return this.cachedActiveWindow;
    }

    // Try to read from disk cache if not in memory and not forcing refresh
    if (!forceRefresh && !this.cachedActiveWindow) {
      logger.info("[WINDOW] Using disk cached active window");
      const diskCache = await perf.track("readDiskCache", () => this.readCacheFromDisk());
      if (diskCache) {
        this.cachedActiveWindow = diskCache;
        logger.info("[WINDOW] Using disk cached active window");
        return diskCache;
      }
    }

    // Bound and cancel EVERY device read below with the same budget + combined
    // signal, so no sub-read (initial dumpsys, API-level probe, API-27 legacy
    // fallback) can outlive the caller deadline or survive an abort. Combining
    // with the ambient request signal is required (see combineWithAmbientAbort):
    // passing only a private/forwarded signal would drop MCP request cancellation.
    const timeoutMs = options.timeoutMs ?? DEFAULT_GET_ACTIVE_TIMEOUT_MS;
    const signal = combineWithAmbientAbort(options.signal);

    try {
      const { stdout } = await perf.track("adbDumpsysWindowWindows", () =>
        this.adb.executeCommand(
          `shell "dumpsys window windows"`,
          timeoutMs,
          undefined,
          true,
          signal,
        ),
      );

      // Detect API level for parsing strategy. An abort during this sub-read
      // rejects out of getAndroidApiLevel (it rethrows when the signal fired)
      // rather than resolving null and letting us parse a post-abort result.
      let apiLevel: number | null = null;
      if (typeof this.adb.getAndroidApiLevel === "function") {
        apiLevel = await this.adb.getAndroidApiLevel(timeoutMs, signal);
      }

      let parsed: { appId: string; activityName: string } | null = null;

      if (apiLevel !== null && apiLevel !== undefined && apiLevel <= 27) {
        // API 27 and below: try mCurrentFocus/mFocusedApp first (most reliable when present)
        parsed = parseDumpsysWindowFocus(stdout);
        if (!parsed) {
          // Fall back to window block scanning (ty=1 + isReadyForDisplay)
          parsed = parseActiveWindowLegacy(stdout);
        }
        if (!parsed) {
          // Try separate dumpsys window command (shorter output)
          parsed = await this.parseActiveWindowFromDumpsysWindow(timeoutMs, signal);
        }
        if (!parsed) {
          // Fall through to modern as safety net
          parsed = parseActiveWindowModern(stdout);
        }
      } else {
        parsed = parseActiveWindowModern(stdout);
      }

      const packageName = parsed?.appId ?? "";
      const activityName = parsed?.activityName ?? "";

      // Extract layout sequence sum from all windows
      let layoutSeqSum = 0;
      const layoutSeqMatches = stdout.matchAll(/mLayoutSeq=([\d\.]+)/g);

      if (layoutSeqMatches) {
        for (const match of layoutSeqMatches) {
          const layoutSeqInt = parseInt(match[1], 10);
          if (!isNaN(layoutSeqInt)) {
            layoutSeqSum += layoutSeqInt;
          }
        }
      }

      const result = { appId: packageName, activityName, layoutSeqSum };

      // Cache the result
      this.cachedActiveWindow = result;
      await this.writeCacheToDisk(result);
      logger.info("[WINDOW] Cached new active window information");

      if (!packageName || !activityName) {
        const sample = stdout.trim().slice(0, 200);
        logger.warn(
          `[WINDOW] Failed to parse active window from dumpsys output. Sample: ${sample || "<empty>"}`,
        );
      }

      return result;
    } catch (err) {
      // A cancellation must PROPAGATE, never be masked as an empty window: the
      // caller aborted (or its budget expired), so returning a synthetic
      // `{appId:""}` would let a post-abort result be parsed/cached/acted on.
      if (signal?.aborted) {
        throw err;
      }
      logger.error(`Failed to get active window information: ${err}`);
      return {
        appId: "",
        activityName: "",
        layoutSeqSum: 0,
      };
    }
  }

  /**
   * Parse mCurrentFocus/mFocusedApp from simpler `dumpsys window` output (API 25 fallback).
   * Bounded by `timeoutMs` and cancelled by `signal`; an abort rethrows so it
   * propagates out of getActive instead of being swallowed to null and letting a
   * post-abort parse continue.
   */
  private async parseActiveWindowFromDumpsysWindow(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{
    appId: string;
    activityName: string;
  } | null> {
    try {
      const { stdout } = await this.adb.executeCommand(
        `shell "dumpsys window"`,
        timeoutMs,
        undefined,
        true,
        signal,
      );
      return parseDumpsysWindowFocus(stdout);
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      logger.error(`Failed to get dumpsys window for legacy fallback: ${err}`);
      return null;
    }
  }

  /**
   * Get a hash of the current activity name
   * @param perf - Optional performance tracker
   * @returns Promise with activity name hash
   */
  async getActiveHash(perf: PerformanceTracker = new NoOpPerformanceTracker()): Promise<string> {
    logger.info("[WINDOW] Getting hash of active window");
    // Always force refresh when getting hash to ensure it reflects current state
    const activeWindow = await this.getActive(true, perf);
    const activityString = JSON.stringify(activeWindow);
    return NodeCryptoService.generateCacheKey(activityString);
  }
}

/**
 * Parse active window from dumpsys window windows output for API 26+ (modern format).
 * Uses 5-pattern fallback chain: imeControlTarget → Pop-Up → visible app → BASE_APPLICATION → visible+BASE_APPLICATION.
 */
export function parseActiveWindowModern(
  stdout: string,
): { appId: string; activityName: string } | null {
  let packageName = "";
  let activityName = "";

  // First try to get from imeControlTarget (original approach)
  const imeControlMatch = stdout.match(
    /imeControlTarget.*?Window\{[^}]*?\s+u\d+\s+([^\s/]+)\/([^\s}]+)\}/,
  );

  if (imeControlMatch && imeControlMatch.length >= 3) {
    packageName = imeControlMatch[1];
    activityName = imeControlMatch[2];
  } else {
    // Handle Pop-Up Window case
    const popupControlMatch = stdout.match(
      /imeControlTarget.*?Window\{([0-9a-f]+)\s+u\d+\s+Pop-Up Window\}/i,
    );

    if (popupControlMatch) {
      const hexRef = popupControlMatch[1];
      const windowRegex = new RegExp(
        `Window #\\d+ Window\\{${hexRef} u\\d+ Pop-Up Window\\}:([\\s\\S]*?)(?=Window #\\d+|$)`,
      );
      const windowMatch = stdout.match(windowRegex);

      if (windowMatch) {
        const activityRecordMatch = windowMatch[1].match(
          /mActivityRecord=ActivityRecord\{[^}]*?\s+u\d+\s+([^\s/]+)\/([^\s}]+)(?:\s+t\d+)?\}/,
        );

        if (activityRecordMatch && activityRecordMatch.length >= 3) {
          packageName = activityRecordMatch[1];
          activityName = activityRecordMatch[2];
        }
      }
    }

    // If still no match, try fallback approaches.
    //
    // This scan is BLOCK-BOUNDED (issue #6289): each window's visibility fields
    // (`mViewVisibility`/`isOnScreen`/`isVisible`) are read only from within
    // that window's own block, delimited by the next `Window #N` header. The
    // previous single-regex form let `[\s\S]*?` run PAST the header window's
    // block, so on API 29-30 captures lacking a parseable imeControlTarget it
    // could pair an EARLIER hidden app's `package/activity` header with a LATER
    // visible window's visibility fields — reporting a backgrounded app as
    // foreground. The scan is also launcher-AWARE: a genuinely-visible launcher
    // window is now a valid foreground result (only SystemUI overlays are
    // excluded), so Home verification reads the launcher instead of falling
    // through to whatever hidden app happened to appear first.
    if (!packageName || !activityName) {
      const visible = parseFirstVisibleModernWindow(stdout);
      if (visible) {
        packageName = visible.appId;
        activityName = visible.activityName;
      }

      if (!packageName || !activityName) {
        const anyAppMatch = stdout.match(
          /Window\{[^}]*?\s+u\d+\s+([^\s/]+)\/([^\s}]+)\}:[\s\S]*?ty=BASE_APPLICATION/,
        );
        if (anyAppMatch && anyAppMatch.length >= 3) {
          packageName = anyAppMatch[1];
          activityName = anyAppMatch[2];
        }
      }
    }

    if (!packageName || !activityName) {
      const visibleAppRegex =
        /Window #\d+ Window\{[^}]*?\s+u\d+\s+([^\s/]+)\/([^\s}]+)\}:[\s\S]*?ty=BASE_APPLICATION[\s\S]*?isOnScreen=true[\s\S]*?isVisible=true/gs;
      const visibleMatch = visibleAppRegex.exec(stdout);

      if (visibleMatch && visibleMatch.length >= 3) {
        packageName = visibleMatch[1];
        activityName = visibleMatch[2];
      }
    }
  }

  if (packageName && activityName) {
    return { appId: packageName, activityName };
  }
  return null;
}

/**
 * Return the first VISIBLE app window from modern (`API 26+`) `dumpsys window
 * windows` output, scanning window-block by window-block so a window's
 * visibility fields are never read across its block boundary (issue #6289).
 *
 * A block qualifies when, within its own `Window #N Window{... pkg/act}:` body,
 * it reports `mViewVisibility=0x0`, `isOnScreen=true`, and `isVisible=true`.
 * SystemUI overlays are skipped; the launcher is NOT skipped (launcher-aware),
 * so a home screen reports the launcher as the reliable foreground.
 */
export function parseFirstVisibleModernWindow(
  stdout: string,
): { appId: string; activityName: string } | null {
  const blockRegex =
    /Window #\d+ Window\{[^}]*?\s+u\d+\s+([^\s/]+)\/([^\s}]+)\}:([\s\S]*?)(?=Window #\d+|$)/g;
  for (const block of stdout.matchAll(blockRegex)) {
    const pkg = block[1];
    const activity = block[2];
    const content = block[3];
    if (!pkg || !activity || pkg.includes("android.systemui")) {
      continue;
    }
    if (
      /mViewVisibility=0x0\b/.test(content) &&
      /isOnScreen=true/.test(content) &&
      /isVisible=true/.test(content)
    ) {
      return { appId: pkg, activityName: activity };
    }
  }
  return null;
}

/**
 * Parse active window from dumpsys window windows output for API 25 and below (legacy format).
 * Looks for Window blocks with ty=1 (BASE_APPLICATION equivalent) and isReadyForDisplay()=true.
 */
export function parseActiveWindowLegacy(
  stdout: string,
): { appId: string; activityName: string } | null {
  // Split into individual window blocks to avoid matching across blocks
  const blockRegex =
    /Window #\d+ Window\{[^}]*?\s+u\d+\s+([^\s/]+)\/([^\s}]+)\}:([\s\S]*?)(?=Window #\d+|$)/g;
  const blocks = [...stdout.matchAll(blockRegex)];

  for (const block of blocks) {
    const pkg = block[1];
    const activity = block[2];
    const content = block[3];

    if (!pkg || !activity) {
      continue;
    }
    if (pkg.includes("android.systemui") || pkg.includes("nexuslauncher")) {
      continue;
    }

    // Check for ty=1 (BASE_APPLICATION on legacy) and isReadyForDisplay()=true within this block
    if (/\bty=1\b/.test(content) && /isReadyForDisplay\(\)=true/.test(content)) {
      return { appId: pkg, activityName: activity };
    }
  }

  return null;
}

/**
 * Parse mCurrentFocus/mFocusedApp from `dumpsys window` output (simpler format, API 25 fallback).
 */
export function parseDumpsysWindowFocus(
  stdout: string,
): { appId: string; activityName: string } | null {
  // Try mCurrentFocus=Window{...pkg/activity}
  const currentFocusMatch = stdout.match(
    /mCurrentFocus=Window\{[^}]*?\s+u\d+\s+([^\s/]+)\/([^\s}]+)\}/,
  );
  if (currentFocusMatch && currentFocusMatch.length >= 3) {
    return { appId: currentFocusMatch[1], activityName: currentFocusMatch[2] };
  }

  // Try mFocusedApp=AppWindowToken{...pkg/activity}
  const focusedAppMatch = stdout.match(/mFocusedApp=AppWindowToken\{[^}]*?\s+([^\s/]+)\/([^\s}]+)/);
  if (focusedAppMatch && focusedAppMatch.length >= 3) {
    return { appId: focusedAppMatch[1], activityName: focusedAppMatch[2] };
  }

  return null;
}

/**
 * SystemUI focus-window names that carry no `package/activity` — they are
 * windows, not ActivityRecords, so `mCurrentFocus` reports a bare token
 * (`mCurrentFocus=Window{... u0 NotificationShade}`). Used to recognize when a
 * SystemUI surface owns input focus from a raw `dumpsys window` read, the
 * ground-truth fallback for issue #6078 when the accessibility windows[] list
 * does not carry a focused-window flag on a given API level.
 */
const SYSTEM_UI_FOCUS_WINDOW_NAMES = new Set<string>([
  "NotificationShade",
  "StatusBar",
  "QuickSettings",
  "ShadeWindow",
  "NavigationBar",
  "Keyguard",
  "KeyguardScrim",
]);

/**
 * True when `dumpsys window` reports a package-less SystemUI surface owning
 * input focus (`mCurrentFocus=Window{... <Name>}` with a bare token). Matches
 * the AOSP focus-window names (shade, quick settings, keyguard, status bar) plus
 * any `*Keyguard*` variant, case-insensitively. Returns false for an ordinary
 * `package/activity` focus (an app owns focus, shade collapsed).
 */
export function isFocusedSystemUiSurface(stdout: string): boolean {
  const match = stdout.match(/mCurrentFocus=Window\{[^}]*?\s+u\d+\s+([^\s}]+)\}/);
  const token = match?.[1];
  if (!token || token.includes("/")) {
    return false;
  }
  return SYSTEM_UI_FOCUS_WINDOW_NAMES.has(token) || /keyguard/i.test(token);
}
