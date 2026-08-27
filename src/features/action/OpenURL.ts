import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange } from "./BaseVisualChange";
import { BootedDevice, OpenURLResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { toActionableError } from "../../models/ActionableError";
import {
  DeviceAppManager,
  DeviceUrlLauncher,
} from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { IOSCtrlProxyManager } from "../../utils/IOSCtrlProxyManager";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { LaunchApp } from "./LaunchApp";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";

const SAFARI_BUNDLE_ID = "com.apple.mobilesafari";

/**
 * URL schemes that iOS resolves to a *system* handler (Mail, Phone, Messages,
 * Maps, …) rather than an arbitrary app. On a physical device these must go
 * through the system/Safari resolver — never the `launchApp`-cached target
 * bundle, which almost certainly can't open a `mailto:`/`tel:` payload. The
 * simulator path already gets this for free via `simctl openurl`.
 */
const SYSTEM_URL_SCHEMES = new Set(["mailto", "tel", "sms", "facetime", "facetime-audio", "maps"]);

/** True when `url`'s scheme is one iOS routes to a built-in system handler. */
const isSystemUrlScheme = (url: string): boolean => {
  const match = url.trim().match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? SYSTEM_URL_SCHEMES.has(match[1].toLowerCase()) : false;
};

export class OpenURL extends BaseVisualChange {
  private readonly simctl: SimCtlClient | null;
  private readonly devicectl: DeviceUrlLauncher | null;

  /**
   * @param device - The target device
   * @param adb - Optional ADB executor (for testing)
   * @param simctl - Optional SimCtlClient for the iOS simulator path (for testing)
   * @param devicectl - Optional DeviceUrlLauncher for the iOS physical-device path (for testing)
   */
  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    simctl: SimCtlClient | null = null,
    devicectl: DeviceUrlLauncher | null = null,
  ) {
    super(device, adb);
    this.device = device;
    this.simctl = simctl;
    this.devicectl = devicectl;
  }

  async execute(url: string): Promise<OpenURLResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("openURL");

    logger.info(`[OpenURL] Starting URL open request: ${url}`);

    // Validate URL
    if (!url || !url.trim()) {
      logger.error("[OpenURL] Invalid URL provided");
      perf.end();
      return {
        success: false,
        url: url || "",
        error: "Invalid URL provided",
      };
    }

    const trimmedUrl = url.trim();
    logger.info(`[OpenURL] Processing URL: ${trimmedUrl}`);

    // Handle package: URLs specially - delegate to LaunchApp
    if (trimmedUrl.startsWith("package:")) {
      logger.info("[OpenURL] Detected package URL, extracting package name");
      const packageName = trimmedUrl.replace("package:", "");

      if (!packageName) {
        logger.error("[OpenURL] No package name found in package URL");
        perf.end();
        return {
          success: false,
          url: trimmedUrl,
          error: "Invalid package URL - no package name specified",
        };
      }

      logger.info(`[OpenURL] Launching app with package name: ${packageName}`);

      try {
        // Use LaunchApp to properly launch the application
        const launchApp = new LaunchApp(this.device, this.adb);
        const launchResult = await perf.track("launchApp", () =>
          launchApp.execute(packageName, false, true),
        );

        perf.end();
        if (launchResult.success) {
          logger.info(`[OpenURL] Successfully launched app ${packageName}`);
          return {
            success: true,
            url: trimmedUrl,
          };
        } else {
          logger.error(`[OpenURL] Failed to launch app ${packageName}: ${launchResult.error}`);
          return {
            success: false,
            url: trimmedUrl,
            error: `Failed to launch app: ${launchResult.error}`,
          };
        }
      } catch (error) {
        logger.error(`[OpenURL] Exception while launching app ${packageName}:`, error);
        perf.end();
        return {
          success: false,
          url: trimmedUrl,
          error: toActionableError(error, "Failed to launch app").message,
        };
      }
    }

    // Handle regular URLs (http, https, mailto, tel, etc.)
    logger.info(`[OpenURL] Processing as regular URL: ${trimmedUrl}`);

    return this.observedInteraction(
      async () => {
        // Platform-specific URL opening execution
        switch (this.device.platform) {
          case "android":
            return await perf.track("androidOpenURL", () => this.executeAndroidOpenURL(trimmedUrl));
          case "ios":
            return await perf.track("iOSOpenURL", () => this.executeiOSOpenURL(trimmedUrl));
          default:
            perf.end();
            throw new Error(`Unsupported platform: ${this.device.platform}`);
        }
      },
      {
        changeExpected: false,
        timeoutMs: 12000,
        perf,
      },
    );
  }

  /**
   * Execute Android-specific URL opening
   * @param url - URL to open
   * @returns Result of the URL opening operation
   */
  private async executeAndroidOpenURL(url: string): Promise<OpenURLResult> {
    // Pass URL through as-is to am start without any reformatting.
    // Android's Intent system handles both hierarchical (scheme://authority/path)
    // and opaque (scheme:scheme-specific-part) URIs correctly.
    //
    // The `am start …` line is issued as ONE argv element, so no host shell ever
    // sees it; adb hands that element to the device's `sh`, which does parse it,
    // so the URL is single-quoted for that shell (issue #4213). Double quotes
    // would leave `"`, `$`, backticks and `\` live.
    await this.adb.execute([
      "shell",
      `am start -a android.intent.action.VIEW -d ${shellQuote(url)}`,
    ]);

    return {
      success: true,
      url,
    };
  }

  /**
   * Execute iOS-specific URL opening. Branches on the canonical
   * {@link isIosSimulatorUdid} signal: simulators keep the simulator-only
   * `simctl openurl` path, while physical devices (iOS 17+) go through
   * `devicectl`, since `simctl` cannot target a physical-device UDID.
   * @param url - URL to open
   * @returns Result of the URL opening operation
   */
  private async executeiOSOpenURL(url: string): Promise<OpenURLResult> {
    if (isIosSimulatorUdid(this.device.deviceId)) {
      return this.executeiOSSimulatorOpenURL(url);
    }
    return this.executeiOSPhysicalOpenURL(url);
  }

  /**
   * Open a URL on an iOS simulator via `xcrun simctl openurl`.
   * @param url - URL to open
   * @returns Result of the URL opening operation
   */
  private async executeiOSSimulatorOpenURL(url: string): Promise<OpenURLResult> {
    try {
      const simctl = this.simctl ?? new SimCtlClient();
      // xcrun simctl openurl <device> <url>, issued as argv so the URL reaches
      // execFile byte-for-byte. The string path re-splits its command, which
      // mangles quotes and backslashes (issue #4213 / #4196).
      await simctl.executeCommandArgs(["openurl", this.device.deviceId, url]);

      return {
        success: true,
        url,
      };
    } catch (error) {
      logger.error(`[OpenURL] simctl openurl failed: ${error}`);
      return {
        success: false,
        url,
        error: toActionableError(
          error,
          `Failed to open URL on iOS simulator ${this.device.deviceId}`,
        ).message,
      };
    }
  }

  /**
   * Open a URL on a physical iOS device (iOS 17+) via `devicectl`. http(s) URLs
   * and system schemes (`mailto:`/`tel:`/`sms:`/…) launch Safari, which resolves
   * universal links and hands off to the owning system handler. App-specific
   * custom-scheme deep links launch the resolved target app bundle (the app
   * targeted by a prior launchApp), falling back to Safari when no target is
   * known.
   * @param url - URL to open
   * @returns Result of the URL opening operation
   */
  private async executeiOSPhysicalOpenURL(url: string): Promise<OpenURLResult> {
    const devicectl = this.devicectl ?? new DeviceAppManager();

    if (!(await devicectl.isUrlLaunchAvailable())) {
      return {
        success: false,
        url,
        error:
          "Opening URLs on a physical iOS device requires Xcode 15+ and iOS 17+ (devicectl). " +
          "Update Xcode/iOS, or open the URL on a simulator.",
      };
    }

    try {
      // http(s) and system schemes (mailto:/tel:/sms:/…) → Safari, so iOS
      // resolves universal links / hands off to Mail/Phone/etc. Only an
      // app-specific custom scheme (myapp://) targets the launchApp-cached
      // bundle — never a system scheme, which the app-under-test can't open.
      // We read the target with the non-constructing getExistingTargetBundleId
      // so a bare openLink can't spin up a CtrlProxy manager (and reserve a
      // service port) just to read it.
      const useSystemResolver = /^https?:\/\//i.test(url.trim()) || isSystemUrlScheme(url);
      const bundleId = useSystemResolver
        ? SAFARI_BUNDLE_ID
        : (IOSCtrlProxyManager.getExistingTargetBundleId(this.device) ?? SAFARI_BUNDLE_ID);
      await devicectl.launchWithPayloadUrl(this.device.deviceId, bundleId, url);
      return {
        success: true,
        url,
      };
    } catch (error) {
      logger.error(`[OpenURL] devicectl open URL failed: ${error}`);
      return {
        success: false,
        url,
        error: toActionableError(error, "Failed to open URL on physical iOS device").message,
      };
    }
  }
}
