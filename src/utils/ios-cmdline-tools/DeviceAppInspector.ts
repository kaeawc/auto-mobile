import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExecResult } from "../../models";
import { hashAppBundle } from "./AppBundleHasher";
import { logger } from "../logger";
import { isRunningInDocker } from "../dockerEnv";
import { getDeviceAppBundleHash, installDeviceApp, isHostControlAvailable, shouldUseHostControl, uninstallDeviceApp } from "../hostControlClient";
import type { Logger } from "../logger";

interface DeviceAppInspectorDependencies {
  platform: () => NodeJS.Platform;
  exec: (command: string) => Promise<ExecResult>;
  readFile: (path: string) => Promise<string>;
  mkdtemp: (prefix: string) => Promise<string>;
  rm: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  stat: (path: string) => Promise<{ isDirectory: () => boolean }>;
  tmpdir: () => string;
  logger: Pick<Logger, "debug" | "warn">;
  hostControl: {
    shouldUseHostControl: () => boolean;
    isRunningInDocker: () => boolean;
    isAvailable: () => Promise<boolean>;
    getAppBundleHash: (deviceId: string, bundleId: string) => Promise<{ success: boolean; error?: string; data?: { hash: string | null } }>;
    uninstallApp: (deviceId: string, bundleId: string) => Promise<{ success: boolean; error?: string }>;
    installApp: (deviceId: string, artifactPath: string) => Promise<{ success: boolean; error?: string; data?: { message: string } }>;
  };
}

const defaultDependencies: DeviceAppInspectorDependencies = {
  platform: () => process.platform,
  exec: async command => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const result = await promisify(exec)(command);
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout.toString();
    const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString();
    return {
      stdout,
      stderr,
      toString() { return stdout; },
      trim() { return stdout.trim(); },
      includes(searchString: string) { return stdout.includes(searchString); }
    };
  },
  readFile: async path => fs.readFile(path, "utf-8"),
  mkdtemp: async prefix => fs.mkdtemp(prefix),
  rm: async path => fs.rm(path, { recursive: true, force: true }),
  readdir: async path => fs.readdir(path),
  stat: async path => fs.stat(path),
  tmpdir,
  logger,
  hostControl: {
    shouldUseHostControl,
    isRunningInDocker,
    isAvailable: () => isHostControlAvailable(),
    getAppBundleHash: async (deviceId: string, bundleId: string) => getDeviceAppBundleHash({ deviceId, bundleId }),
    uninstallApp: async (deviceId: string, bundleId: string) => uninstallDeviceApp({ deviceId, bundleId }),
    installApp: async (deviceId: string, artifactPath: string) => installDeviceApp({ deviceId, artifactPath })
  }
};

const quoteShell = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

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

export const findBundleEntry = (data: unknown, bundleId: string): Record<string, unknown> | null => {
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
  const idValue = record.bundleIdentifier ?? record.bundleID ?? record.bundleId ?? record.CFBundleIdentifier ?? record.BUNDLE_IDENTIFIER;
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

const extractBundlePath = (entry: Record<string, unknown>): string | null => {
  const candidates = [
    entry.bundleURL,
    entry.bundlePath,
    entry.bundleURLString,
    entry.bundle_url,
    entry.bundle_path,
    entry.url,
    entry.path
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
  deps: DeviceAppInspectorDependencies
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

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Recursively find the launched process's `processIdentifier` in a devicectl
 * `process launch --json-output` payload. The stable location is
 * `result.process.processIdentifier`; we prefer it and fall back to a deep
 * search so a devicectl-version reshuffle of the envelope still yields the PID.
 */
export const findProcessIdentifier = (data: unknown): number | undefined => {
  const direct = (data as { result?: { process?: { processIdentifier?: unknown } } })
    ?.result?.process?.processIdentifier;
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
 * Two-pass, per issue #2488: the strict inside-bundle match is preferred, but if
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
  return walk(data, exe => pathBasename(exe) === appName);
};

const isExpectedMissingLegacySimulatorApp = (bundleId: string, errorMessage: string): boolean =>
  bundleId.endsWith(".XCTestServiceApp") &&
  (errorMessage.includes("No such file or directory") ||
    errorMessage.includes("NSPOSIXErrorDomain, code=2"));

export class DeviceAppInspector {
  private readonly deps: DeviceAppInspectorDependencies;

  constructor(deps: DeviceAppInspectorDependencies = defaultDependencies) {
    this.deps = deps;
  }

  public async getInstalledAppBundleHash(deviceUdid: string, bundleId: string, isSimulator = false): Promise<string | null> {
    if (isSimulator) {
      return this.getSimulatorAppBundleHash(deviceUdid, bundleId);
    }

    const useHostControl = this.deps.hostControl.shouldUseHostControl() && this.deps.hostControl.isRunningInDocker();
    if (useHostControl) {
      const available = await this.deps.hostControl.isAvailable();
      if (!available) {
        this.deps.logger.warn("[DeviceAppInspector] Host control not available for devicectl");
        return null;
      }

      const result = await this.deps.hostControl.getAppBundleHash(deviceUdid, bundleId);
      if (!result.success) {
        this.deps.logger.warn(`[DeviceAppInspector] Host control devicectl failed: ${result.error || "Unknown error"}`);
        return null;
      }
      return result.data?.hash ?? null;
    }

    // withInstalledAppBundle propagates callback errors; preserve this method's
    // null-on-failure contract by swallowing a hashing failure here.
    try {
      return await this.withInstalledAppBundle(deviceUdid, bundleId, bundlePath => hashAppBundle(bundlePath));
    } catch (error) {
      this.deps.logger.warn(`[DeviceAppInspector] Failed to hash installed app bundle for ${bundleId}: ${error instanceof Error ? error.message : String(error)}`);
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
   *
   * Not available under host control (Docker): the host-control bridge exposes
   * install/uninstall but no primitive to copy the installed bundle off-device,
   * so we can't obtain a reinstall artifact. We fail with an explicit message
   * rather than the misleading "could not resolve bundle" from the darwin path.
   */
  public async clearAppDataViaReinstall(deviceUdid: string, bundleId: string): Promise<void> {
    const useHostControl = this.deps.hostControl.shouldUseHostControl() && this.deps.hostControl.isRunningInDocker();
    if (useHostControl) {
      throw new Error(
        `Clearing app data via uninstall+reinstall is not supported under host control for ${bundleId}: ` +
        "the host-control bridge cannot copy the installed bundle off-device to reinstall it."
      );
    }

    const done = await this.withInstalledAppBundle(deviceUdid, bundleId, async bundlePath => {
      await this.uninstallApp(deviceUdid, bundleId, false);
      await this.installApp(deviceUdid, bundlePath);
      return true;
    });
    if (!done) {
      throw new Error(`Could not resolve installed bundle for ${bundleId} to reinstall`);
    }
  }

  /**
   * Copy the device-installed `.app` bundle to a temp dir and run `fn` against
   * its on-disk path, cleaning up temp dirs afterward. Returns null if the bundle
   * can't be located (or not on macOS). Local devicectl path only — host-control
   * callers handle their own remote primitives.
   *
   * Lookup failures (info/copy) are swallowed → null. The callback's own errors
   * PROPAGATE: clearAppDataViaReinstall must surface an install failure that
   * happens after the uninstall, not mask it as "could not resolve bundle".
   */
  private async withInstalledAppBundle<T>(
    deviceUdid: string,
    bundleId: string,
    fn: (bundlePath: string) => Promise<T>
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
        const infoCommand = [
          "xcrun",
          "devicectl",
          "device",
          "info",
          "apps",
          "--device", deviceUdid,
          "--bundle-id", bundleId,
          "--json-output", quoteShell(jsonPath),
          "--quiet"
        ].join(" ");
        await this.deps.exec(infoCommand);

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
        const copyCommand = [
          "xcrun",
          "devicectl",
          "device",
          "copy",
          "from",
          "--device", deviceUdid,
          "--source", quoteShell(bundlePath),
          "--destination", quoteShell(copyDir),
          "--quiet"
        ].join(" ");
        await this.deps.exec(copyCommand);

        bundleOnDisk = await findAppBundleInDir(copyDir, this.deps);
      } catch (error) {
        this.deps.logger.warn(`[DeviceAppInspector] Failed to read installed app bundle for ${bundleId}: ${error instanceof Error ? error.message : String(error)}`);
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

  public async uninstallApp(deviceUdid: string, bundleId: string, isSimulator = false): Promise<void> {
    if (isSimulator) {
      return this.uninstallSimulatorApp(deviceUdid, bundleId);
    }

    const useHostControl = this.deps.hostControl.shouldUseHostControl() && this.deps.hostControl.isRunningInDocker();
    if (useHostControl) {
      const available = await this.deps.hostControl.isAvailable();
      if (!available) {
        this.deps.logger.warn("[DeviceAppInspector] Host control not available for devicectl uninstall");
        return;
      }

      const result = await this.deps.hostControl.uninstallApp(deviceUdid, bundleId);
      if (!result.success) {
        throw new Error(result.error || "Host control devicectl uninstall failed");
      }
      return;
    }

    if (this.deps.platform() !== "darwin") {
      return;
    }
    const command = [
      "xcrun",
      "devicectl",
      "device",
      "uninstall",
      "app",
      "--device", deviceUdid,
      quoteShell(bundleId),
      "--quiet"
    ].join(" ");
    await this.deps.exec(command);
  }

  public async installApp(deviceUdid: string, artifactPath: string): Promise<void> {
    const useHostControl = this.deps.hostControl.shouldUseHostControl() && this.deps.hostControl.isRunningInDocker();
    if (useHostControl) {
      const available = await this.deps.hostControl.isAvailable();
      if (!available) {
        this.deps.logger.warn("[DeviceAppInspector] Host control not available for devicectl install");
        throw new Error("Host control not available for physical device app installation");
      }

      const result = await this.deps.hostControl.installApp(deviceUdid, artifactPath);
      if (!result.success) {
        throw new Error(result.error || "Host control devicectl install failed");
      }
      return;
    }

    if (this.deps.platform() !== "darwin") {
      throw new Error("Physical device app installation requires macOS");
    }
    const command = [
      "xcrun",
      "devicectl",
      "device",
      "install",
      "app",
      "--device", deviceUdid,
      quoteShell(artifactPath),
      "--quiet"
    ].join(" ");
    await this.deps.exec(command);
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
   * Gated to macOS + local devicectl. Host control (Docker) exposes no launch
   * bridge, so we return an explicit, actionable error rather than a confusing
   * simctl-style failure.
   */
  public async launchApp(
    deviceUdid: string,
    bundleId: string,
    options: { terminateExisting?: boolean } = {}
  ): Promise<{ success: boolean; pid?: number; error?: string }> {
    const useHostControl = this.deps.hostControl.shouldUseHostControl() && this.deps.hostControl.isRunningInDocker();
    if (useHostControl) {
      return {
        success: false,
        error: `Launching apps on a physical device is not supported under host control for ${bundleId}: ` +
          "the host-control bridge exposes install/uninstall but no devicectl process-launch primitive."
      };
    }

    if (this.deps.platform() !== "darwin") {
      return { success: false, error: "Physical device app launch requires macOS" };
    }

    const tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-launch-"));
    const jsonPath = join(tempDir, "launch.json");
    try {
      const command = [
        "xcrun",
        "devicectl",
        "device",
        "process",
        "launch",
        "--device", deviceUdid,
        ...(options.terminateExisting ? ["--terminate-existing"] : []),
        "--json-output", quoteShell(jsonPath),
        "--quiet",
        quoteShell(bundleId)
      ].join(" ");
      await this.deps.exec(command);

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
   * path against `device info processes` executables) then `device process
   * signal --signal SIGKILL` that PID.
   *
   * Returns:
   * - `{ wasInstalled: false, wasRunning: false }` when the bundle isn't installed
   *   (no process query, no signal),
   * - `{ wasInstalled: true, wasRunning: false }` when installed but no matching
   *   process is running (no signal),
   * - `{ wasInstalled: true, wasRunning: true }` after SIGKILL of a running process.
   *
   * Throws on an underlying devicectl failure. Gated to macOS + local devicectl:
   * host control (Docker) exposes no process-management bridge, and non-darwin
   * hosts have no devicectl, so both throw an explicit, actionable error rather
   * than a confusing simctl-style failure (iOS ≤16 devices reject the devicectl
   * signal at the tool level and surface as a thrown devicectl error).
   */
  public async terminateApp(deviceUdid: string, bundleId: string): Promise<{ wasInstalled: boolean; wasRunning: boolean }> {
    const useHostControl = this.deps.hostControl.shouldUseHostControl() && this.deps.hostControl.isRunningInDocker();
    if (useHostControl) {
      throw new Error(
        `Terminating an app on a physical device is not supported under host control for ${bundleId}: ` +
        "the host-control bridge exposes install/uninstall but no devicectl process-management primitive."
      );
    }

    if (this.deps.platform() !== "darwin") {
      throw new Error("Physical iOS device app termination requires macOS");
    }

    const bundlePath = await this.resolveInstalledBundlePathOnDevice(deviceUdid, bundleId);
    if (!bundlePath) {
      return { wasInstalled: false, wasRunning: false };
    }

    const pid = await this.resolveRunningPid(deviceUdid, bundlePath);
    if (pid === null) {
      return { wasInstalled: true, wasRunning: false };
    }

    const signalCommand = [
      "xcrun",
      "devicectl",
      "device",
      "process",
      "signal",
      "--device", deviceUdid,
      "--pid", String(pid),
      "--signal", "SIGKILL"
    ].join(" ");
    await this.deps.exec(signalCommand);
    return { wasInstalled: true, wasRunning: true };
  }

  /**
   * Resolve the on-device installed bundle path for `bundleId` via
   * `devicectl device info apps --bundle-id`. Returns null when the app isn't
   * installed (no matching bundle entry / no resolvable path); devicectl exec or
   * JSON-read failures propagate so a broken devicectl surfaces rather than
   * masquerading as "not installed". macOS-only (callers guard the platform).
   */
  private async resolveInstalledBundlePathOnDevice(deviceUdid: string, bundleId: string): Promise<string | null> {
    const tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-"));
    const jsonPath = join(tempDir, "apps.json");
    try {
      const infoCommand = [
        "xcrun",
        "devicectl",
        "device",
        "info",
        "apps",
        "--device", deviceUdid,
        "--bundle-id", bundleId,
        "--json-output", quoteShell(jsonPath),
        "--quiet"
      ].join(" ");
      await this.deps.exec(infoCommand);

      const raw = await this.deps.readFile(jsonPath);
      const data = JSON.parse(raw) as unknown;
      const entry = findBundleEntry(data, bundleId);
      if (!entry) {
        return null;
      }
      return extractBundlePath(entry);
    } finally {
      await this.deps.rm(tempDir);
    }
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
      const command = [
        "xcrun",
        "devicectl",
        "device",
        "info",
        "processes",
        "--device", deviceUdid,
        "--json-output", quoteShell(jsonPath),
        "--quiet"
      ].join(" ");
      await this.deps.exec(command);

      const raw = await this.deps.readFile(jsonPath);
      return findRunningProcessPid(JSON.parse(raw), bundlePath);
    } finally {
      await this.deps.rm(tempDir);
    }
  }

  private async getSimulatorAppBundleHash(deviceUdid: string, bundleId: string): Promise<string | null> {
    if (this.deps.platform() !== "darwin") {
      return null;
    }

    let appPath: string;
    try {
      const result = await this.deps.exec(`xcrun simctl get_app_container ${quoteShell(deviceUdid)} ${quoteShell(bundleId)} app`);
      appPath = result.trim();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const logMessage = `[DeviceAppInspector] Failed to read simulator app bundle for ${bundleId}: ${errorMessage}`;
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
      this.deps.logger.warn(`[DeviceAppInspector] Failed to hash simulator app bundle for ${bundleId}: ${getErrorMessage(error)}`);
      return null;
    }
  }

  private async uninstallSimulatorApp(deviceUdid: string, bundleId: string): Promise<void> {
    if (this.deps.platform() !== "darwin") {
      return;
    }
    await this.deps.exec(`xcrun simctl uninstall ${quoteShell(deviceUdid)} ${quoteShell(bundleId)}`);
  }
}

export const parseDevicectlJsonOutputPath = parseJsonOutputPath;
