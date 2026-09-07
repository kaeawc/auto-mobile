import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { combineWithAmbientAbort } from "../../utils/AbortContext";

/**
 * Verify that a "go home" action actually landed on the home screen by
 * resolving the device's ACTUALLY-CONFIGURED HOME launcher at runtime and
 * comparing the foreground package against it, instead of trusting a
 * dispatch method's self-reported result.
 *
 * Background (issue #6147): on Android API 28 the CtrlProxy accessibility
 * global action for "home" can report success while the foreground app is
 * unchanged (or even navigates within the same app, mimicking Back). Home
 * actions must not report success on the strength of that self-reported
 * result alone -- they need to confirm the foreground package actually
 * became the launcher.
 *
 * A prior version of this module matched the foreground package against a
 * hardcoded 7-package prefix list. That was both too NARROW (a device whose
 * selected HOME app isn't in the list makes every successful Home press look
 * like a failure) and too LOOSE (prefix matching accepts an unrelated app
 * like `com.android.launcher3.example`). Resolving the real configured
 * launcher and comparing by EXACT match fixes both.
 */

/**
 * Shell command used to resolve the device's configured HOME launcher
 * package, via the standard `cmd package` surface (routed through the
 * injected {@link AdbExecutor}, never a raw child-process call). Typical
 * output is two lines, the second of the form `<package>/<activity>`:
 *
 *   priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true
 *   com.example.launcher/.LauncherActivity
 */
const RESOLVE_HOME_COMMAND =
  "shell cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN";

/** Timeout for the `cmd package resolve-activity` read. */
const RESOLVE_HOME_TIMEOUT_MS = 5000;

/**
 * Fallback launcher packages, used ONLY when the device's configured HOME
 * launcher cannot be resolved at runtime (e.g. `cmd package` unavailable, or
 * the resolve command failing/timing out). Matched by EXACT package name --
 * never by prefix, so an unrelated app like `com.android.launcher3.example`
 * cannot be misclassified as a launcher. Mirrors `Idle.isSystemLauncher`'s
 * launcher packages, including the legacy AOSP `com.android.launcher`.
 */
const FALLBACK_LAUNCHER_PACKAGES: ReadonlySet<string> = new Set([
  "com.android.launcher",
  "com.android.launcher3",
  "com.google.android.apps.nexuslauncher",
  "com.samsung.android.app.launcher",
  "com.miui.home",
  "com.oneplus.launcher",
  "com.huawei.android.launcher",
  "com.sec.android.app.launcher",
]);

/**
 * How long a resolved HOME launcher package stays valid before it must be
 * re-resolved. The cache used to be process-lifetime: once a device's
 * launcher was resolved, changing the default HOME app while the daemon kept
 * running had no effect -- every later verification kept comparing against
 * the stale package, so `isForegroundLauncher` rejected the real (new)
 * launcher and both the global-action and ADB fallback paths reported
 * failure until the daemon restarted.
 *
 * 30 seconds is short enough that a user who just changed their default HOME
 * app sees it take effect well within a single interactive session, but long
 * enough that the repeated Home presses within one test/automation run (which
 * can happen several times a second) still hit the cache instead of
 * re-querying `cmd package resolve-activity` on every call.
 */
const RESOLVED_HOME_PACKAGE_TTL_MS = 30_000;

interface ResolvedHomePackageCacheEntry {
  packageName: string;
  resolvedAtMs: number;
  /**
   * The device CONNECTION EPOCH this entry was resolved under, e.g.
   * `BootedDevice.transportId` -- undefined when the caller has no
   * incarnation info to offer. Android serials are reused across connection
   * epochs (see `daemon/deviceSessionRegistry.ts`; e.g. a fresh AVD taking
   * over `emulator-5554` within the TTL below), so keying this cache on
   * `deviceId` alone lets a same-serial reincarnation serve the PREVIOUS
   * device's launcher for up to {@link RESOLVED_HOME_PACKAGE_TTL_MS}.
   * Comparing this token on read treats an incarnation change as a cache
   * miss even though the serial is unchanged.
   */
  incarnationToken: string | undefined;
}

/**
 * Per-device cache of the resolved configured HOME launcher package. Only
 * successful resolutions are cached -- a transient failure retries on the
 * next call rather than permanently downgrading that device to the fallback
 * list for the rest of the process's lifetime. Entries expire after
 * {@link RESOLVED_HOME_PACKAGE_TTL_MS} so a changed default HOME launcher is
 * picked up without a daemon restart, and are invalidated by a device
 * INCARNATION change on the same serial (see
 * {@link ResolvedHomePackageCacheEntry.incarnationToken}).
 */
const resolvedHomePackageCache = new Map<string, ResolvedHomePackageCacheEntry>();

/**
 * Parse the package name out of `cmd package resolve-activity --brief`
 * output. Only the last non-empty line, of the form `<package>/<activity>`,
 * matters -- any preceding metadata line is ignored.
 */
function parseResolvedHomePackage(stdout: string): string | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return null;
  }
  const match = lastLine.match(/^([^\s/]+)\//);
  return match ? match[1] : null;
}

/**
 * The cached package name, but only when it is still within
 * {@link RESOLVED_HOME_PACKAGE_TTL_MS} of `now` AND was resolved under the
 * same `incarnationToken`. Returns undefined for "no cache entry", "cache
 * entry expired", and "cache entry belongs to a superseded incarnation" --
 * the caller re-resolves in all three cases.
 */
function freshCachedPackageName(
  cached: ResolvedHomePackageCacheEntry | undefined,
  now: number,
  incarnationToken: string | undefined,
): string | undefined {
  if (cached === undefined || cached.incarnationToken !== incarnationToken) {
    return undefined;
  }
  return now - cached.resolvedAtMs < RESOLVED_HOME_PACKAGE_TTL_MS ? cached.packageName : undefined;
}

/**
 * Resolve the device's actually-configured HOME launcher package, caching a
 * successful result per device (for {@link RESOLVED_HOME_PACKAGE_TTL_MS}) so
 * repeated verification retries within a single Home-press don't re-query.
 * Returns null when resolution fails or yields no usable package -- callers
 * must fall back to {@link isFallbackLauncherPackage} in that case.
 *
 * @param incarnationToken - A discriminator for the device's current
 *   connection epoch, e.g. `BootedDevice.transportId`. A cached entry
 *   resolved under a DIFFERENT token (same `deviceId`, new incarnation -- a
 *   reused Android serial such as `emulator-5554` picked up by a fresh AVD
 *   within the TTL) is treated as a cache miss and re-resolved, instead of
 *   serving the previous incarnation's launcher. Omit to keep the previous
 *   serial-only keying (e.g. callers with no incarnation info available).
 * @param timeoutMs - Optional remaining budget for the resolve command. When
 *   provided the ADB query is bounded to `min(RESOLVE_HOME_TIMEOUT_MS,
 *   timeoutMs)` so a caller spending a shrinking request deadline (e.g. home
 *   verification) cannot overrun; omit to use the full default.
 */
export async function resolveConfiguredHomePackage(
  adb: AdbExecutor,
  deviceId: string,
  timer: Timer = defaultTimer,
  incarnationToken?: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string | null> {
  const now = timer.now();
  const cached = resolvedHomePackageCache.get(deviceId);
  const freshCachedPackage = freshCachedPackageName(cached, now, incarnationToken);
  if (freshCachedPackage !== undefined) {
    return freshCachedPackage;
  }
  // Deadline-bounded AND cancellable: combine the caller's signal with the
  // ambient request signal so a cancelled request still aborts this resolve,
  // then rethrow on abort so cancellation propagates instead of being swallowed
  // into a null that downgrades to the fallback list. When a caller passes a
  // remaining budget (e.g. home-press verification spending its request
  // deadline), bound the resolve to whichever is smaller so it cannot overrun.
  const combinedSignal = combineWithAmbientAbort(signal);
  const resolveTimeoutMs =
    timeoutMs === undefined
      ? RESOLVE_HOME_TIMEOUT_MS
      : Math.max(1, Math.min(RESOLVE_HOME_TIMEOUT_MS, timeoutMs));
  try {
    const result = await adb.executeCommand(
      RESOLVE_HOME_COMMAND,
      resolveTimeoutMs,
      undefined,
      true,
      combinedSignal,
    );
    const packageName = parseResolvedHomePackage(result.stdout);
    if (packageName) {
      resolvedHomePackageCache.set(deviceId, {
        packageName,
        resolvedAtMs: now,
        incarnationToken,
      });
    }
    return packageName;
  } catch (error) {
    if (combinedSignal?.aborted) {
      throw error;
    }
    logger.warn(
      `[androidLauncherPackages] Failed to resolve configured HOME launcher package: ${errorMessage(error)}`,
      error,
    );
    return null;
  }
}

/** Clear the resolved-HOME-package cache (all devices, or just one). */
export function clearResolvedHomePackageCache(deviceId?: string): void {
  if (deviceId === undefined) {
    resolvedHomePackageCache.clear();
  } else {
    resolvedHomePackageCache.delete(deviceId);
  }
}

/**
 * True when `appId` is a known fallback launcher package, matched EXACTLY
 * (never by prefix). Used only when the configured HOME launcher could not
 * be resolved at runtime.
 */
export function isFallbackLauncherPackage(appId: string | null | undefined): boolean {
  if (!appId) {
    return false;
  }
  return FALLBACK_LAUNCHER_PACKAGES.has(appId);
}

/**
 * True when `appId` is the foreground launcher: an EXACT match against the
 * device's actually-configured HOME package when resolvable, or a known
 * fallback launcher package otherwise.
 *
 * @param incarnationToken - Forwarded to {@link resolveConfiguredHomePackage}
 *   -- see its doc for why a device's connection-epoch discriminator (e.g.
 *   `BootedDevice.transportId`) must be supplied to avoid serving a reused
 *   serial's stale cached launcher.
 * @param timeoutMs - Optional remaining budget forwarded to
 *   {@link resolveConfiguredHomePackage} so the launcher lookup shares the
 *   caller's deadline instead of always taking the full resolve default.
 */
export async function isForegroundLauncher(
  appId: string | null | undefined,
  adb: AdbExecutor,
  deviceId: string,
  timer: Timer = defaultTimer,
  incarnationToken?: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<boolean> {
  if (!appId) {
    return false;
  }
  const configuredHome = await resolveConfiguredHomePackage(
    adb,
    deviceId,
    timer,
    incarnationToken,
    signal,
    timeoutMs,
  );
  if (configuredHome) {
    return appId === configuredHome;
  }
  return isFallbackLauncherPackage(appId);
}
