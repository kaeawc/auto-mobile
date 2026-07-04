import type { ExecResult } from "../../models";
import { isRunningInDocker } from "../dockerEnv";
import { shouldUseHostControl } from "../hostControlClient";

/**
 * Single-quote a value for safe interpolation into a `/bin/sh -c` command,
 * matching {@link DeviceAppInspector}'s convention. `--device <udid>` is passed
 * unquoted (UDIDs are `[0-9A-F-]`), while user-controlled url + bundle id are
 * quoted to prevent shell injection.
 */
const quoteShell = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Narrow seam OpenURL depends on to open a URL on a *physical* iOS device.
 * Implemented by {@link DeviceCtlClient}; faked in tests so the URL path never
 * shells out. Kept minimal (YAGNI): OpenURL only needs to know whether the
 * physical-device path is usable and how to launch a bundle with a payload URL.
 */
export interface DeviceUrlLauncher {
  /** True when `devicectl` can service a physical-device open-URL request. */
  isAvailable(): Promise<boolean>;
  /**
   * Open `url` on a physical iOS device by launching `bundleId` with the URL as
   * its launch payload. Throws with actionable context on failure (unsupported
   * host, host-control mode, or an underlying devicectl error).
   */
  launchWithPayloadUrl(deviceUdid: string, bundleId: string, url: string): Promise<void>;
}

export interface DeviceCtlDependencies {
  platform: () => NodeJS.Platform;
  exec: (command: string) => Promise<ExecResult>;
  hostControl: {
    shouldUseHostControl: () => boolean;
    isRunningInDocker: () => boolean;
  };
}

const defaultDependencies: DeviceCtlDependencies = {
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
  hostControl: {
    shouldUseHostControl,
    isRunningInDocker,
  }
};

/**
 * Thin, injectable wrapper over `xcrun devicectl` for opening URLs / deep links
 * on a *physical* iOS device (Xcode 15+/iOS 17+). Mirrors
 * {@link DeviceAppInspector}'s dependency-injection + `process.platform ===
 * "darwin"` guard so it stays unit-testable with a fake `exec`, and returns the
 * same explicit "not supported under host control" posture for Docker.
 *
 * Simulators are handled by the `simctl openurl` path in OpenURL and never reach
 * this client.
 */
export class DeviceCtlClient implements DeviceUrlLauncher {
  private readonly deps: DeviceCtlDependencies;

  constructor(deps: DeviceCtlDependencies = defaultDependencies) {
    this.deps = deps;
  }

  private isHostControlMode(): boolean {
    return this.deps.hostControl.shouldUseHostControl() && this.deps.hostControl.isRunningInDocker();
  }

  /**
   * True when the physical-device open-URL path is usable.
   *
   * Under Docker host control we report `true` even though `devicectl` isn't
   * reachable locally: the host-control bridge exposes no launch-with-URL
   * primitive yet, so we let the caller proceed to {@link launchWithPayloadUrl},
   * which returns the precise "not supported under host control" error rather
   * than the generic missing-devicectl message. Otherwise this requires a macOS
   * host with a working `devicectl` (Xcode 15+).
   */
  async isAvailable(): Promise<boolean> {
    if (this.isHostControlMode()) {
      return true;
    }
    if (this.deps.platform() !== "darwin") {
      return false;
    }
    try {
      await this.deps.exec("xcrun devicectl --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Open a URL on a physical iOS device (Xcode 15+/iOS 17+) by launching
   * `bundleId` with the URL as its launch payload. For http(s) URLs the caller
   * passes `com.apple.mobilesafari` so Safari resolves universal links;
   * custom-scheme URLs pass the owning/target app bundle id.
   */
  async launchWithPayloadUrl(deviceUdid: string, bundleId: string, url: string): Promise<void> {
    if (this.isHostControlMode()) {
      throw new Error(
        "Opening a URL on a physical iOS device is not supported under host control: " +
        "the host-control bridge exposes no devicectl launch-with-URL primitive."
      );
    }
    if (this.deps.platform() !== "darwin") {
      throw new Error("Opening URLs on a physical iOS device requires macOS");
    }
    const command = [
      "xcrun", "devicectl", "device", "process", "launch",
      "--device", deviceUdid,            // unquoted, matching DeviceAppInspector
      "--payload-url", quoteShell(url),
      "--terminate-existing",
      quoteShell(bundleId)
    ].join(" ");
    await this.deps.exec(command);
  }
}
