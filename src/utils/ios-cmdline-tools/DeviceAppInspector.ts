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

  private async getSimulatorAppBundleHash(deviceUdid: string, bundleId: string): Promise<string | null> {
    if (this.deps.platform() !== "darwin") {
      return null;
    }

    let appPath: string;
    try {
      const result = await this.deps.exec(`xcrun simctl get_app_container ${quoteShell(deviceUdid)} ${quoteShell(bundleId)} app`);
      appPath = result.trim();
    } catch (error) {
      this.deps.logger.debug(`[DeviceAppInspector] Failed to read simulator app bundle for ${bundleId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    if (!appPath) {
      return null;
    }

    try {
      return await hashAppBundle(appPath);
    } catch (error) {
      this.deps.logger.warn(`[DeviceAppInspector] Failed to hash simulator app bundle for ${bundleId}: ${error instanceof Error ? error.message : String(error)}`);
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
