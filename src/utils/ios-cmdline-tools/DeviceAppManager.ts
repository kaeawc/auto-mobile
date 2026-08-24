import { errorMessage } from "../describeUnknownError";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExecResult } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { hashAppBundle } from "./AppBundleHasher";
import { isProcessAlreadyGoneError } from "./iosProcessErrors";
import { iosMajorVersionFromDevicectlDetails } from "./iosVersion";
import { logger } from "../logger";
import { DefaultHostCommandExecutor } from "../HostCommandExecutor";
import type { Logger } from "../logger";

interface DeviceAppManagerDependencies {
  platform: () => NodeJS.Platform;
  execute: (file: string, args: string[]) => Promise<ExecResult>;
  readFile: (path: string) => Promise<string>;
  mkdtemp: (prefix: string) => Promise<string>;
  rm: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  stat: (path: string) => Promise<{ isDirectory: () => boolean }>;
  tmpdir: () => string;
  logger: Pick<Logger, "debug" | "warn">;
}

type LaunchPreconditionResult = { ok: true } | { ok: false; reason: "non-darwin" };

const defaultDependencies: DeviceAppManagerDependencies = {
  platform: () => process.platform,
  execute: (file, args) => new DefaultHostCommandExecutor().executeCommand(file, args),
  readFile: async (path) => fs.readFile(path, "utf-8"),
  mkdtemp: async (prefix) => fs.mkdtemp(prefix),
  rm: async (path) => fs.rm(path, { recursive: true, force: true }),
  readdir: async (path) => fs.readdir(path),
  stat: async (path) => fs.stat(path),
  tmpdir,
  logger,
};

/**
 * Lowest major iOS version whose physical-device process management
 * (`devicectl device process launch`/`terminate`) is supported. devicectl gained
 * process management with iOS 17 / Xcode 15; on iOS ≤16 devices the underlying
 * call fails with a generic tool error, so callers gate on this and surface an
 * explicit, version-specific message instead. See issue #3056.
 */
const MIN_DEVICECTL_PROCESS_IOS_MAJOR = 17;

/** Actionable "requires iOS 17+" message for a physical-device `verb` on an iOS ≤16 device. */
const requiresIos17Message = (verb: string, bundleId: string, major: number): string =>
  `${verb} ${bundleId} on a physical iOS device requires iOS ${MIN_DEVICECTL_PROCESS_IOS_MAJOR}+ ` +
  `(devicectl process management); this device reports iOS ${major}.`;

const parseJsonOutputPath = (command: string): string | null => {
  const match = command.match(/--json-output\s+([^\s]+)/);
  if (match) {
    return match[1].replace(/^['"]|['"]$/g, "");
  }
  return null;
};

const normalizeDevicePath = (rawPath: string): string => {
  if (rawPath.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(rawPath).pathname);
    } catch {
      return rawPath.replace("file://", "");
    }
  }
  return rawPath;
};

export const findBundleEntry = (
  data: unknown,
  bundleId: string,
): Record<string, unknown> | null => {
  if (!data || typeof data !== "object") {
    return null;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findBundleEntry(item, bundleId);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = data as Record<string, unknown>;
  const idValue =
    record.bundleIdentifier ??
    record.bundleID ??
    record.bundleId ??
    record.CFBundleIdentifier ??
    record.BUNDLE_IDENTIFIER;
  if (typeof idValue === "string" && idValue === bundleId) {
    return record;
  }

  for (const value of Object.values(record)) {
    const found = findBundleEntry(value, bundleId);
    if (found) {
      return found;
    }
  }
  return null;
};

/**
 * Pull the installed-app records out of a `devicectl device info apps`
 * payload. devicectl nests the listing under `result.apps`, while the
 * `--bundle-id` shape used elsewhere in this module (and the fixtures that
 * pin it) writes a bare `{ apps: [...] }`. Search for the first `apps` array
 * either way rather than hardcoding one envelope, and drop non-object
 * members so callers can treat every entry as a record.
 *
 * Returns null when the payload carries no `apps` array at all — that is a
 * payload this code does not understand, which must not be reported as the
 * device having no apps installed. An `apps` array that is present but empty
 * returns `[]`, because that genuinely means "nothing installed".
 */
export const extractInstalledAppEntries = (data: unknown): Record<string, unknown>[] | null => {
  if (!data || typeof data !== "object") {
    return null;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = extractInstalledAppEntries(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = data as Record<string, unknown>;
  if (Array.isArray(record.apps)) {
    return record.apps.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
  }

  for (const value of Object.values(record)) {
    const found = extractInstalledAppEntries(value);
    if (found) {
      return found;
    }
  }
  return null;
};

const extractBundlePath = (entry: Record<string, unknown>): string | null => {
  const candidates = [
    entry.bundleURL,
    entry.bundlePath,
    entry.bundleURLString,
    entry.bundle_url,
    entry.bundle_path,
    entry.url,
    entry.path,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return normalizeDevicePath(candidate);
    }
  }
  return null;
};

const findAppBundleInDir = async (
  root: string,
  deps: DeviceAppManagerDependencies,
): Promise<string | null> => {
  const entries = await deps.readdir(root);
  for (const entry of entries) {
    const fullPath = join(root, entry);
    const stats = await deps.stat(fullPath);
    if (stats.isDirectory()) {
      if (entry.endsWith(".app")) {
        return fullPath;
      }
      const nested = await findAppBundleInDir(fullPath, deps);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
};

const getErrorMessage = (error: unknown): string => errorMessage(error);

/**
 * Full text of a failed `exec` rejection. Promisified `child_process.exec`
 * rejects with an Error whose `message` is "Command failed: <cmd>" and whose
 * `stdout`/`stderr` carry the tool's actual diagnostic — devicectl writes its
 * ESRCH "No such process" text to stderr, so we must inspect the captured
 * streams, not just message. stdout is included as a cheap belt-and-suspenders:
 * with `--quiet` devicectl uses stderr, but its error framing is undocumented.
 */
const getExecErrorText = (error: unknown): string => {
  const parts = [getErrorMessage(error)];
  if (error && typeof error === "object") {
    for (const field of ["stderr", "stdout"] as const) {
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0) {
        parts.push(value);
      }
    }
  }
  return parts.join("\n");
};

/**
 * True when a devicectl `process terminate` failure means the target PID was
 * already gone — it exited between our `info processes` resolution and the kill
 * (a real on-device race, issue #3054). devicectl surfaces ESRCH either as the
 * localized "No such process" strerror text or, on some builds, the bare
 * `NSPOSIXErrorDomain error 3` code without the strerror gloss.
 *
 * The shared already-gone phrasings live in {@link isProcessAlreadyGoneError}
 * (used by the simulator path too, issue #3076); here we OR-in the two
 * devicectl-specific extras so a raced exit reports an effectively-terminated
 * app instead of a false `success:false`. Together these preserve the exact
 * prior devicectl behavior: shared `not running` ∪ extra `no longer running`.
 *
 * Deliberately narrow: unrelated failures (device locked, not connected,
 * permission denied) must still propagate as hard errors. The "not running"
 * family is scoped to the *process* so a device/CoreDevice-level "not running"
 * message can never be mistaken for an already-exited PID.
 */
export const isDevicectlProcessGoneError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    isProcessAlreadyGoneError(message) ||
    normalized.includes("nsposixerrordomain error 3") || // bare ESRCH code
    /process (?:is )?no longer running/.test(normalized)
  ); // devicectl-only phrasing
};

/**
 * Recursively find the launched process's `processIdentifier` in a devicectl
 * `process launch --json-output` payload. The stable location is
 * `result.process.processIdentifier`; we prefer it and fall back to a deep
 * search so a devicectl-version reshuffle of the envelope still yields the PID.
 */
export const findProcessIdentifier = (data: unknown): number | undefined => {
  const direct = (data as { result?: { process?: { processIdentifier?: unknown } } })?.result
    ?.process?.processIdentifier;
  if (typeof direct === "number") {
    return direct;
  }

  const walk = (node: unknown): number | undefined => {
    if (!node || typeof node !== "object") {
      return undefined;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.processIdentifier === "number") {
      return record.processIdentifier;
    }
    for (const value of Object.values(record)) {
      const found = walk(value);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(data);
};

const extractExecutablePath = (record: Record<string, unknown>): string | null => {
  const raw = record.executable ?? record.executablePath ?? record.executableURL ?? record.path;
  if (typeof raw === "string") {
    return normalizeDevicePath(raw);
  }
  if (raw && typeof raw === "object") {
    const inner = (raw as Record<string, unknown>).url ?? (raw as Record<string, unknown>).path;
    if (typeof inner === "string") {
      return normalizeDevicePath(inner);
    }
  }
  return null;
};

const extractProcessPid = (record: Record<string, unknown>): number | undefined => {
  const raw = record.processIdentifier ?? record.pid ?? record.processID;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  // devicectl JSON is unverified; tolerate a stringified integer PID too.
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return undefined;
};

/** Basename of a path (last `/`-separated segment), ignoring any trailing slash. */
const pathBasename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

/**
 * Find the PID of the app's **own** main process from a devicectl
 * `device info processes --json-output` payload, given its installed
 * `bundlePath`.
 *
 * The exact envelope is not formally documented by Apple (see simctl.md caveat),
 * so we deep-walk and accept several field-name spellings: the executable may be
 * a string or an object carrying `url`/`path`, and the PID may be spelled
 * `processIdentifier`, `pid`, or `processID`.
 *
 * Matching is deliberately scoped to the **main app binary**, which is a *direct
 * child* of the `.app` directory (`MyApp.app/MyApp` — CFBundleExecutable, whose
 * name may differ from the bundle name, but always one level down). App
 * extensions live *inside* the same bundle at `MyApp.app/PlugIns/Foo.appex/Foo`
 * and their executables also start with `"<bundle>/"`, so a naive prefix match
 * would SIGKILL an extension and falsely report the app terminated. We therefore
 * require the path segment after `"<bundle>/"` to contain no further `/`. This
 * also excludes a sibling like `MyApp.app.extension/...` (different prefix).
 *
 * Two-pass, per issue #2882: the strict inside-bundle match is preferred, but if
 * it finds nothing we fall back to matching a process whose executable
 * **basename** equals the bundle name (minus `.app`). The fallback guards the
 * real-device risk that `info processes` executable paths don't nest under the
 * `info apps` bundle URL (e.g. `/private` vs `/var` symlink, differing container
 * roots) — without it a mismatch would silently report the app as not running.
 * The basename fallback naturally still excludes extensions (a `Foo.appex`
 * binary's basename won't equal the app name).
 */
export const findRunningProcessPid = (data: unknown, bundlePath: string): number | null => {
  const normalizedBundle = normalizeDevicePath(bundlePath).replace(/\/+$/, "");
  if (!normalizedBundle) {
    return null;
  }
  const insidePrefix = `${normalizedBundle}/`;
  const appName = pathBasename(normalizedBundle).replace(/\.app$/i, "");

  const isMainBinaryOfBundle = (exe: string): boolean => {
    if (!exe.startsWith(insidePrefix)) {
      return false;
    }
    // Direct child only: no further path separator → the app's own binary,
    // not a nested PlugIns/*.appex/* extension executable.
    return !exe.slice(insidePrefix.length).includes("/");
  };

  const walk = (node: unknown, matches: (exe: string) => boolean): number | null => {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, matches);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    const exe = extractExecutablePath(record);
    const pid = extractProcessPid(record);
    if (exe !== null && pid !== undefined && matches(exe)) {
      return pid;
    }
    for (const value of Object.values(record)) {
      const found = walk(value, matches);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };

  const primary = walk(data, isMainBinaryOfBundle);
  if (primary !== null) {
    return primary;
  }
  if (!appName) {
    return null;
  }
  return walk(data, (exe) => pathBasename(exe) === appName);
};

const isExpectedMissingLegacySimulatorApp = (bundleId: string, errorMessage: string): boolean =>
  bundleId.endsWith(".XCTestServiceApp") &&
  (errorMessage.includes("No such file or directory") ||
    errorMessage.includes("NSPOSIXErrorDomain, code=2"));

/**
 * Narrow seam OpenURL depends on to open a URL on a *physical* iOS device.
 * Implemented by {@link DeviceAppManager} (the shared `devicectl` wrapper);
 * faked in tests so the URL path never shells out. Kept minimal (YAGNI): OpenURL
 * only needs to know whether the physical-device path is usable and how to launch
 * a bundle with a payload URL.
 */
export interface DeviceUrlLauncher {
  /** True when `devicectl` can service a physical-device open-URL request. */
  isUrlLaunchAvailable(): Promise<boolean>;
  /**
   * Open `url` on a physical iOS device by launching `bundleId` with the URL as
   * its launch payload. Throws with actionable context on failure (unsupported
   * host or an underlying devicectl error).
   */
  launchWithPayloadUrl(deviceUdid: string, bundleId: string, url: string): Promise<void>;
}

export class DeviceAppManager implements DeviceUrlLauncher {
  private readonly deps: DeviceAppManagerDependencies;

  constructor(deps: DeviceAppManagerDependencies = defaultDependencies) {
    this.deps = deps;
  }

  private execute(file: string, args: string[]): Promise<ExecResult> {
    return this.deps.execute(file, args);
  }

  private getLaunchPrecondition(): LaunchPreconditionResult {
    if (this.deps.platform() !== "darwin") {
      return { ok: false, reason: "non-darwin" };
    }
    return { ok: true };
  }

  /**
   * True when the physical-device open-URL path is usable.
   *
   * Requires a macOS host with a working `devicectl` (Xcode 15+).
   *
   * Part of the {@link DeviceUrlLauncher} seam OpenURL depends on; simulators are
   * handled by the `simctl openurl` path in OpenURL and never reach this method.
   * Named distinctly so the multi-purpose class exposes an unambiguous
   * URL-launch availability check.
   */
  async isUrlLaunchAvailable(): Promise<boolean> {
    if (this.deps.platform() !== "darwin") {
      return false;
    }
    try {
      await this.execute("xcrun", ["devicectl", "--version"]);
      return true;
    } catch (error) {
      // `devicectl --version` fails when Xcode 15+ isn't installed; that just means physical-device URL launch is unavailable.
      logger.debug(
        `src/utils/ios-cmdline-tools/DeviceAppManager.ts fallback failed: ${error}`,
        error,
      );
      return false;
    }
  }

  /**
   * Open a URL on a physical iOS device (Xcode 15+/iOS 17+) by launching
   * `bundleId` with the URL as its launch payload. For http(s) URLs the caller
   * passes `com.apple.mobilesafari` so Safari resolves universal links;
   * custom-scheme URLs pass the owning/target app bundle id. Values are passed
   * as argv, so URLs and bundle ids cannot alter command structure. Near-clone of
   * {@link launchApp}, differing only by the `--payload-url` flag; kept distinct
   * because it carries no PID-capture/JSON-output plumbing.
   */
  async launchWithPayloadUrl(deviceUdid: string, bundleId: string, url: string): Promise<void> {
    const precondition = this.getLaunchPrecondition();
    if (!precondition.ok) {
      throw new ActionableError("Opening URLs on a physical iOS device requires macOS");
    }
    const args = [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      deviceUdid, // unquoted, matching the other devicectl calls
      "--payload-url",
      url,
      "--terminate-existing",
      bundleId,
    ];
    try {
      await this.execute("xcrun", args);
    } catch (error) {
      throw toActionableError(error, `Failed to open URL on physical iOS device ${bundleId}`);
    }
  }

  public async getInstalledAppBundleHash(
    deviceUdid: string,
    bundleId: string,
    isSimulator = false,
  ): Promise<string | null> {
    if (isSimulator) {
      return this.getSimulatorAppBundleHash(deviceUdid, bundleId);
    }

    // withInstalledAppBundle propagates callback errors; preserve this method's
    // null-on-failure contract by swallowing a hashing failure here.
    try {
      return await this.withInstalledAppBundle(deviceUdid, bundleId, (bundlePath) =>
        hashAppBundle(bundlePath),
      );
    } catch (error) {
      this.deps.logger.warn(
        `[DeviceAppManager] Failed to hash installed app bundle for ${bundleId}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Clear a physical device app's data by uninstalling and reinstalling it.
   * iOS exposes no direct data-wipe for on-device sandboxes, so we copy the
   * installed (device-signed) bundle off the device, uninstall the app — which
   * removes its data container — and reinstall the copied bundle. The app
   * returns in a fresh state. Throws if the installed bundle can't be resolved,
   * or with the underlying devicectl error if the uninstall/install step fails
   * (so a post-uninstall install failure surfaces rather than being masked).
   */
  public async clearAppDataViaReinstall(deviceUdid: string, bundleId: string): Promise<void> {
    const done = await this.withInstalledAppBundle(deviceUdid, bundleId, async (bundlePath) => {
      await this.uninstallApp(deviceUdid, bundleId, false);
      await this.installApp(deviceUdid, bundlePath);
      return true;
    });
    if (!done) {
      throw new ActionableError(`Could not resolve installed bundle for ${bundleId} to reinstall`);
    }
  }

  /**
   * Copy the device-installed `.app` bundle to a temp dir and run `fn` against
   * its on-disk path, cleaning up temp dirs afterward. Returns null if the bundle
   * can't be located (or not on macOS).
   *
   * Lookup failures (info/copy) are swallowed → null. The callback's own errors
   * PROPAGATE: clearAppDataViaReinstall must surface an install failure that
   * happens after the uninstall, not mask it as "could not resolve bundle".
   */
  private async withInstalledAppBundle<T>(
    deviceUdid: string,
    bundleId: string,
    fn: (bundlePath: string) => Promise<T>,
  ): Promise<T | null> {
    if (this.deps.platform() !== "darwin") {
      return null;
    }

    const tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-"));
    const jsonPath = join(tempDir, "apps.json");
    let copyDir: string | undefined;
    try {
      let bundleOnDisk: string | null;
      try {
        const infoArgs = [
          "devicectl",
          "device",
          "info",
          "apps",
          "--device",
          deviceUdid,
          "--bundle-id",
          bundleId,
          "--json-output",
          jsonPath,
          "--quiet",
        ];
        await this.execute("xcrun", infoArgs);

        const raw = await this.deps.readFile(jsonPath);
        const data = JSON.parse(raw) as unknown;
        const entry = findBundleEntry(data, bundleId);
        if (!entry) {
          return null;
        }
        const bundlePath = extractBundlePath(entry);
        if (!bundlePath) {
          return null;
        }

        copyDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-device-app-"));
        const copyArgs = [
          "devicectl",
          "device",
          "copy",
          "from",
          "--device",
          deviceUdid,
          "--source",
          bundlePath,
          "--destination",
          copyDir,
          "--quiet",
        ];
        await this.execute("xcrun", copyArgs);

        bundleOnDisk = await findAppBundleInDir(copyDir, this.deps);
      } catch (error) {
        this.deps.logger.warn(
          `[DeviceAppManager] Failed to read installed app bundle for ${bundleId}: ${errorMessage(error)}`,
        );
        return null;
      }

      if (!bundleOnDisk) {
        return null;
      }
      // Outside the lookup try/catch: callback errors propagate to the caller.
      return await fn(bundleOnDisk);
    } finally {
      if (copyDir) {
        await this.deps.rm(copyDir);
      }
      await this.deps.rm(tempDir);
    }
  }

  public async uninstallApp(
    deviceUdid: string,
    bundleId: string,
    isSimulator = false,
  ): Promise<void> {
    if (isSimulator) {
      return this.uninstallSimulatorApp(deviceUdid, bundleId);
    }

    if (this.deps.platform() !== "darwin") {
      return;
    }
    const args = [
      "devicectl",
      "device",
      "uninstall",
      "app",
      "--device",
      deviceUdid,
      bundleId,
      "--quiet",
    ];
    try {
      await this.execute("xcrun", args);
    } catch (error) {
      throw toActionableError(error, `Failed to uninstall ${bundleId} on physical iOS device`);
    }
  }

  public async installApp(deviceUdid: string, artifactPath: string): Promise<void> {
    if (this.deps.platform() !== "darwin") {
      throw new ActionableError("Physical device app installation requires macOS");
    }
    const args = [
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      deviceUdid,
      artifactPath,
      "--quiet",
    ];
    try {
      await this.execute("xcrun", args);
    } catch (error) {
      throw toActionableError(error, "Failed to install app on physical iOS device");
    }
  }

  /**
   * Launch an app on a physical iOS device via `devicectl` and return its PID.
   * Mirrors {@link SimCtlClient.launchApp}'s `{ success; pid?; error? }` contract
   * so `LaunchApp.executeiOS` can substitute this for the simctl path without
   * changing downstream handling. `terminateExisting` maps to
   * `--terminate-existing`, which is the authoritative cold-boot relaunch: it
   * terminates any already-running instance and starts a fresh process (which
   * foregrounds). devicectl has no foreground-if-running verb, so warm launches
   * also relaunch this way. This subsumes a separate "terminate then launch" —
   * there is intentionally no standalone devicectl terminate here, because
   * devicectl's `info processes` listing exposes no stable bundle-id field to
   * resolve a PID by bundle (only `install`/`info apps` do), so a reliable
   * terminate-by-bundle needs the follow-up device app-listing work.
   *
   * Gated to macOS + local devicectl.
   */
  public async launchApp(
    deviceUdid: string,
    bundleId: string,
    options: { terminateExisting?: boolean } = {},
  ): Promise<{ success: boolean; pid?: number; error?: string }> {
    const precondition = this.getLaunchPrecondition();
    if (!precondition.ok) {
      return { success: false, error: "Physical device app launch requires macOS" };
    }

    // iOS ≤16 devices lack devicectl process management (#3056): detect the
    // version first and return the explicit "requires iOS 17+" error rather than
    // a generic launch failure. Unknown versions (null) proceed to the real call.
    const major = await this.resolveDeviceMajorIosVersion(deviceUdid);
    if (major !== null && major < MIN_DEVICECTL_PROCESS_IOS_MAJOR) {
      return { success: false, error: requiresIos17Message("Launching", bundleId, major) };
    }

    const tempDir = await this.deps.mkdtemp(
      join(this.deps.tmpdir(), "automobile-devicectl-launch-"),
    );
    const jsonPath = join(tempDir, "launch.json");
    try {
      const args = [
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        deviceUdid,
        ...(options.terminateExisting ? ["--terminate-existing"] : []),
        "--json-output",
        jsonPath,
        "--quiet",
        bundleId,
      ];
      await this.execute("xcrun", args);

      const raw = await this.deps.readFile(jsonPath);
      const pid = findProcessIdentifier(JSON.parse(raw));
      return { success: true, pid };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    } finally {
      await this.deps.rm(tempDir);
    }
  }

  /**
   * Force-terminate a running app on a physical iOS device (iOS 17+) via
   * devicectl. There is no `terminate-by-bundle-id` verb, so this is a two-step
   * operation: resolve the bundle id to a PID (by matching the on-device bundle
   * path against `device info processes` executables) then force-kill that PID
   * with the dedicated `device process terminate --kill` verb (SIGKILL).
   *
   * Returns:
   * - `{ wasInstalled: false, wasRunning: false }` when the bundle isn't installed
   *   (no process query, no terminate),
   * - `{ wasInstalled: true, wasRunning: false }` when installed but no matching
   *   process is running (no terminate),
   * - `{ wasInstalled: true, wasRunning: true }` after terminating a running
   *   process — including the race where the resolved PID exits on its own
   *   between resolution and the kill (devicectl returns ESRCH / "No such
   *   process"; see {@link isDevicectlProcessGoneError}). The app is gone either
   *   way, so we report success rather than a false failure.
   *
   * Throws on an underlying devicectl failure that is *not* the already-exited
   * race (e.g. device locked / not connected). Gated to macOS + local devicectl;
   * non-darwin hosts have no devicectl, so they throw an explicit, actionable
   * error rather than a confusing simctl-style failure (iOS ≤16 devices reject
   * the devicectl terminate at the tool level and surface as a thrown devicectl
   * error).
   */
  public async terminateApp(
    deviceUdid: string,
    bundleId: string,
  ): Promise<{ wasInstalled: boolean; wasRunning: boolean }> {
    if (this.deps.platform() !== "darwin") {
      throw new ActionableError("Physical iOS device app termination requires macOS");
    }

    // iOS ≤16 devices lack devicectl process management (#3056): detect the
    // version first and throw the explicit "requires iOS 17+" error rather than a
    // generic devicectl terminate failure. Unknown versions (null) proceed.
    const major = await this.resolveDeviceMajorIosVersion(deviceUdid);
    if (major !== null && major < MIN_DEVICECTL_PROCESS_IOS_MAJOR) {
      throw new ActionableError(requiresIos17Message("Terminating", bundleId, major));
    }

    const bundlePath = await this.resolveInstalledBundlePathOnDevice(deviceUdid, bundleId);
    if (!bundlePath) {
      return { wasInstalled: false, wasRunning: false };
    }

    const pid = await this.resolveRunningPid(deviceUdid, bundlePath);
    if (pid === null) {
      return { wasInstalled: true, wasRunning: false };
    }

    const terminateArgs = [
      "devicectl",
      "device",
      "process",
      "terminate",
      "--device",
      deviceUdid,
      "--pid",
      String(pid),
      "--kill",
      "--quiet",
    ];
    try {
      await this.execute("xcrun", terminateArgs);
    } catch (error) {
      const message = getExecErrorText(error);
      // Race (#3054): the PID resolved from `info processes` exited before the
      // kill landed, so devicectl returns non-zero (ESRCH / "No such process")
      // and promisified exec rejects. The app is nonetheless gone, so report
      // success rather than surfacing a false `success:false`. Swallow only the
      // already-exited case; any other failure (device locked, not connected)
      // still propagates. Log at debug since this is an expected non-error.
      if (!isDevicectlProcessGoneError(message)) {
        // Wrap in an ActionableError that carries the full exec diagnostic —
        // devicectl writes its actionable failure text (e.g. "device is locked")
        // to stderr, which getExecErrorText folds into `message`. A bare rethrow
        // of `error` keeps stderr only on a non-enumerable field the MCP client
        // never sees; a plain String(error) drops it entirely.
        throw new ActionableError(
          `Failed to terminate ${bundleId} (PID ${pid}) on physical iOS device: ${message}`,
        );
      }
      this.deps.logger.debug(
        `[DeviceAppManager] terminate PID ${pid} for ${bundleId} raced an exit; treating as terminated: ${message}`,
      );
    }
    // wasRunning:true in both the killed and raced-exit cases: we positively
    // resolved a live PID above, so the app *was* running and is now gone. This
    // is more honest than false and distinguishes the race from the
    // installed-but-not-running case handled earlier.
    return { wasInstalled: true, wasRunning: true };
  }

  /**
   * Query the on-device `devicectl device info apps --bundle-id` payload and
   * return the matching bundle entry (raw devicectl record), or null when the
   * app isn't installed. devicectl exec / JSON-read failures PROPAGATE so a
   * broken devicectl surfaces rather than masquerading as "not installed".
   * macOS-only (callers guard the platform). Shared core behind
   * {@link resolveInstalledBundlePathOnDevice} and {@link getInstalledAppInfo}.
   */
  private async queryInstalledAppEntry(
    deviceUdid: string,
    bundleId: string,
  ): Promise<Record<string, unknown> | null> {
    const tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-"));
    const jsonPath = join(tempDir, "apps.json");
    try {
      const infoArgs = [
        "devicectl",
        "device",
        "info",
        "apps",
        "--device",
        deviceUdid,
        "--bundle-id",
        bundleId,
        "--json-output",
        jsonPath,
        "--quiet",
      ];
      await this.execute("xcrun", infoArgs);

      const raw = await this.deps.readFile(jsonPath);
      const data = JSON.parse(raw) as unknown;
      return findBundleEntry(data, bundleId);
    } finally {
      await this.deps.rm(tempDir);
    }
  }

  /**
   * List every app `devicectl device info apps` reports for a physical device,
   * as raw devicectl records. This is the physical-device counterpart of
   * `simctl listapps`, so `ListInstalledApps` can answer on real hardware
   * instead of returning an empty list (issue #2883).
   *
   * Unlike {@link queryInstalledAppEntry} this omits `--bundle-id`, which is
   * what turns the lookup into a full listing. devicectl exec / JSON-read
   * failures are wrapped and PROPAGATE: an empty list must mean "no apps", not
   * "devicectl is broken", because callers report that distinction as their
   * `successful` flag. macOS-only.
   */
  public async listInstalledApps(deviceUdid: string): Promise<Record<string, unknown>[]> {
    if (this.deps.platform() !== "darwin") {
      throw new ActionableError(
        "Listing apps on a physical iOS device requires macOS (devicectl is Xcode-only)",
      );
    }

    const tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-"));
    const jsonPath = join(tempDir, "apps.json");
    try {
      await this.execute("xcrun", [
        "devicectl",
        "device",
        "info",
        "apps",
        "--device",
        deviceUdid,
        "--json-output",
        jsonPath,
        "--quiet",
      ]);

      const raw = await this.deps.readFile(jsonPath);
      const apps = extractInstalledAppEntries(JSON.parse(raw) as unknown);
      if (!apps) {
        throw new ActionableError(
          `devicectl reported no app listing for ${deviceUdid}; its JSON output carried no "apps" array`,
        );
      }
      return apps;
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to list installed apps on physical iOS device ${deviceUdid}`,
      );
    } finally {
      // A failed temp-dir cleanup must not replace the devicectl or JSON
      // diagnostic the caller needs.
      try {
        await this.deps.rm(tempDir);
      } catch (cleanupError) {
        this.deps.logger.warn(
          `[DeviceAppManager] Failed to remove temporary app listing directory ${tempDir}: ${getErrorMessage(cleanupError)}`,
        );
      }
    }
  }

  /**
   * Best-effort metadata read: return the on-device `devicectl device info apps`
   * bundle entry for `bundleId`, or null. Unlike {@link queryInstalledAppEntry},
   * this is non-throwing — it returns null off macOS (no devicectl) and logs a
   * warning then returns null on any devicectl/JSON failure, matching the
   * diagnostic contract of the app-metadata resource that consumes it (a lookup
   * failure degrades to "no metadata" rather than surfacing as an error).
   */
  public async getInstalledAppInfo(
    deviceUdid: string,
    bundleId: string,
  ): Promise<Record<string, unknown> | null> {
    if (this.deps.platform() !== "darwin") {
      return null;
    }
    try {
      return await this.queryInstalledAppEntry(deviceUdid, bundleId);
    } catch (error) {
      this.deps.logger.warn(
        `[DeviceAppManager] Failed to get physical device app info for ${bundleId}: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Resolve the on-device installed bundle path for `bundleId` via
   * `devicectl device info apps --bundle-id`. Returns null when the app isn't
   * installed (no matching bundle entry / no resolvable path); devicectl exec or
   * JSON-read failures propagate so a broken devicectl surfaces rather than
   * masquerading as "not installed". macOS-only (callers guard the platform).
   */
  private async resolveInstalledBundlePathOnDevice(
    deviceUdid: string,
    bundleId: string,
  ): Promise<string | null> {
    const entry = await this.queryInstalledAppEntry(deviceUdid, bundleId);
    if (!entry) {
      return null;
    }
    return extractBundlePath(entry);
  }

  /**
   * Map an on-device bundle path to a running PID via
   * `devicectl device info processes`, matching the process whose executable
   * lives inside `bundlePath`. Returns null when nothing is running for that
   * bundle. devicectl exec / JSON-read failures propagate. macOS-only.
   */
  private async resolveRunningPid(deviceUdid: string, bundlePath: string): Promise<number | null> {
    const tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-"));
    const jsonPath = join(tempDir, "processes.json");
    try {
      const args = [
        "devicectl",
        "device",
        "info",
        "processes",
        "--device",
        deviceUdid,
        "--json-output",
        jsonPath,
        "--quiet",
      ];
      await this.execute("xcrun", args);

      const raw = await this.deps.readFile(jsonPath);
      return findRunningProcessPid(JSON.parse(raw), bundlePath);
    } finally {
      await this.deps.rm(tempDir);
    }
  }

  /**
   * Best-effort resolve the device's major iOS version via
   * `devicectl device info details --json-output`. Returns null when the version
   * can't be determined (devicectl failure, unrecognized JSON envelope) so the
   * version gate stays advisory: an unknown version proceeds to the real call
   * rather than blocking a possibly-supported device. macOS-only (callers guard
   * the platform before invoking this).
   */
  private async resolveDeviceMajorIosVersion(deviceUdid: string): Promise<number | null> {
    const tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-"));
    const jsonPath = join(tempDir, "details.json");
    try {
      const args = [
        "devicectl",
        "device",
        "info",
        "details",
        "--device",
        deviceUdid,
        "--json-output",
        jsonPath,
        "--quiet",
      ];
      await this.execute("xcrun", args);
      const raw = await this.deps.readFile(jsonPath);
      return iosMajorVersionFromDevicectlDetails(raw);
    } catch (error) {
      // Version detection is a best-effort probe: a failure here must not block a
      // possibly-supported device, so log-and-continue with an "unknown" (null)
      // version. The subsequent real devicectl call still surfaces any true error.
      this.deps.logger.debug(
        `[DeviceAppManager] Could not resolve iOS version for ${deviceUdid}: ${getErrorMessage(error)}`,
      );
      return null;
    } finally {
      await this.deps.rm(tempDir);
    }
  }

  private async getSimulatorAppBundleHash(
    deviceUdid: string,
    bundleId: string,
  ): Promise<string | null> {
    if (this.deps.platform() !== "darwin") {
      return null;
    }

    let appPath: string;
    try {
      const result = await this.execute("xcrun", [
        "simctl",
        "get_app_container",
        deviceUdid,
        bundleId,
        "app",
      ]);
      appPath = result.trim();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const logMessage = `[DeviceAppManager] Failed to read simulator app bundle for ${bundleId}: ${errorMessage}`;
      if (isExpectedMissingLegacySimulatorApp(bundleId, errorMessage)) {
        this.deps.logger.debug(logMessage);
      } else {
        this.deps.logger.warn(logMessage);
      }
      return null;
    }

    if (!appPath) {
      return null;
    }

    try {
      return await hashAppBundle(appPath);
    } catch (error) {
      this.deps.logger.warn(
        `[DeviceAppManager] Failed to hash simulator app bundle for ${bundleId}: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  private async uninstallSimulatorApp(deviceUdid: string, bundleId: string): Promise<void> {
    if (this.deps.platform() !== "darwin") {
      return;
    }
    await this.execute("xcrun", ["simctl", "uninstall", deviceUdid, bundleId]);
  }
}

export const parseDevicectlJsonOutputPath = parseJsonOutputPath;
