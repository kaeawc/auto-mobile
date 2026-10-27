import { errorMessage } from "../utils/describeUnknownError";
import { toActionableError } from "../models/ActionableError";
import { isAndroidFrameworkUnavailable } from "../utils/android-cmdline-tools/isAndroidFrameworkUnavailable";
import { AdbCommandTimeoutError } from "../utils/android-cmdline-tools/AdbClient";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AndroidDeviceTraits } from "../utils/android-cmdline-tools/deviceTraits";
import { logger } from "../utils/logger";
import { packageListingContains } from "../utils/android-cmdline-tools/shellOutputHeuristics";
import { ActionableError } from "../models";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { Timer } from "../utils/SystemTimer";
import { CTRL_PROXY_PACKAGE } from "./constants";
import type { ToggleCapabilities } from "./AndroidCtrlProxyManagerTypes";
import { settingsCommand, userFlag } from "./setupUser";

/** Live manager dependencies; callbacks preserve manager overrides and test spies. */
export interface AndroidCtrlProxyAccessibilityHost {
  cachedAvailability: { isAvailable: boolean; timestamp: number } | null;
  readonly timer: Timer;
  readonly adb: AdbExecutor;
  readDeviceTraits(): Promise<AndroidDeviceTraits>;
  statusInspectionDeviceError(error: unknown): Error | undefined;
  isInstalled(): Promise<boolean>;
  isEnabled(_signal?: AbortSignal, options?: { bypassCache?: boolean }): Promise<boolean>;
  assertNotDrivenByOtherDaemon(signal?: AbortSignal): Promise<void>;
  getToggleCapabilities(): Promise<ToggleCapabilities>;
  clearAvailabilityCache(): void;
  enableViaSettings(): Promise<void>;
  getApiLevel(): Promise<[number | null, boolean]>;
  /** The user to set CtrlProxy up for on a headless-system-user device; undefined everywhere else. */
  setupUser(): Promise<number | undefined>;
}

/** Accessibility settings, capability detection and cached availability. */
export class AndroidCtrlProxyAccessibility {
  private static readonly AVAILABILITY_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private static readonly NEGATIVE_CACHE_TTL = 5 * 1000; // 5 seconds

  // Static caches for individual status checks
  private cachedInstallation: { isInstalled: boolean; timestamp: number } | null = null;

  private cachedEnabled: { isEnabled: boolean; timestamp: number } | null = null;

  private static readonly STATUS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  // Cache for toggle capabilities (settings permissions don't change during session)
  private cachedToggleCapabilities: ToggleCapabilities | null = null;
  constructor(private readonly host: AndroidCtrlProxyAccessibilityHost) {}
  clearStatusCache(): void {
    this.host.cachedAvailability = null;
    this.cachedInstallation = null;
    this.cachedEnabled = null;
  }
  clearToggleCache(): void {
    this.cachedToggleCapabilities = null;
  }

  /**
   * Check if Accessibility Service is installed on the device
   */
  async isInstalled(): Promise<boolean> {
    // Check cache first
    if (this.cachedInstallation) {
      const cacheAge = this.host.timer.now() - this.cachedInstallation.timestamp;
      const ttl = this.cachedInstallation.isInstalled
        ? AndroidCtrlProxyAccessibility.STATUS_CACHE_TTL
        : AndroidCtrlProxyAccessibility.NEGATIVE_CACHE_TTL;
      if (cacheAge < ttl) {
        logger.debug(
          `[CTRL_PROXY] Using cached installation status (age: ${cacheAge}ms): ${this.cachedInstallation.isInstalled ? "installed" : "not installed"}`,
        );
        return this.cachedInstallation.isInstalled;
      } else {
        this.cachedInstallation = null;
      }
    }

    // Resolved outside the try: an unreadable foreground user must surface as itself.
    const user = await this.host.setupUser();
    try {
      logger.debug("[CTRL_PROXY] Checking if accessibility service is installed");
      const result = await this.host.adb.executeCommand(
        `shell pm list packages${userFlag(user)} ${CTRL_PROXY_PACKAGE}`,
        { noRetry: true },
      );
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      if (isAndroidFrameworkUnavailable(diagnostic)) {
        throw new ActionableError(diagnostic);
      }
      const deviceError = this.host.statusInspectionDeviceError(diagnostic);
      if (deviceError) {
        throw deviceError;
      }
      const isInstalled = packageListingContains(result.stdout, CTRL_PROXY_PACKAGE);

      // Cache the result
      this.cachedInstallation = {
        isInstalled,
        timestamp: this.host.timer.now(),
      };

      logger.debug(
        `[CTRL_PROXY] Service installation status: ${isInstalled ? "installed" : "not installed"} (cached for ${AndroidCtrlProxyAccessibility.STATUS_CACHE_TTL / 1000 / 60} minutes)`,
      );
      return isInstalled;
    } catch (error) {
      return this.handleStatusInspectionFailure(error, "installation");
    }
  }

  /**
   * Check if Accessibility Service is enabled as an input method
   */
  async isEnabled(
    _signal?: AbortSignal,
    options: { bypassCache?: boolean } = {},
  ): Promise<boolean> {
    // Check cache first
    if (!options.bypassCache && this.cachedEnabled) {
      const cacheAge = this.host.timer.now() - this.cachedEnabled.timestamp;
      const ttl = this.cachedEnabled.isEnabled
        ? AndroidCtrlProxyAccessibility.STATUS_CACHE_TTL
        : AndroidCtrlProxyAccessibility.NEGATIVE_CACHE_TTL;
      if (cacheAge < ttl) {
        logger.debug(
          `[CTRL_PROXY] Using cached enabled status (age: ${cacheAge}ms): ${this.cachedEnabled.isEnabled ? "enabled" : "disabled"}`,
        );
        return this.cachedEnabled.isEnabled;
      } else {
        this.cachedEnabled = null;
      }
    }

    const user = await this.host.setupUser();
    try {
      logger.debug("[CTRL_PROXY] Checking if accessibility service is enabled");
      const result = await this.host.adb.executeCommand(
        settingsCommand(user, "get secure enabled_accessibility_services"),
      );
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      if (isAndroidFrameworkUnavailable(diagnostic)) {
        throw new ActionableError(diagnostic);
      }
      const deviceError = this.host.statusInspectionDeviceError(diagnostic);
      if (deviceError) {
        throw deviceError;
      }
      const isEnabled = result.stdout.includes(CTRL_PROXY_PACKAGE);

      // Cache the result
      this.cachedEnabled = {
        isEnabled,
        timestamp: this.host.timer.now(),
      };

      logger.debug(
        `[CTRL_PROXY] Service enabled status: ${isEnabled ? "enabled" : "disabled"} (cached for ${AndroidCtrlProxyAccessibility.STATUS_CACHE_TTL / 1000 / 60} minutes)`,
      );
      return isEnabled;
    } catch (error) {
      return this.handleStatusInspectionFailure(error, "enabled");
    }
  }

  private handleStatusInspectionFailure(error: unknown, status: "installation" | "enabled"): false {
    // Missing framework services can be transient during boot, while ADB
    // transport failures must retain their typed device identity.
    if (isAndroidFrameworkUnavailable(error)) {
      throw toActionableError(error, "Android framework unavailable");
    }
    const deviceError = this.host.statusInspectionDeviceError(error);
    if (deviceError) {
      throw deviceError;
    }
    // A timed-out package listing says nothing about whether CtrlProxy is
    // installed; returning false would start a multi-minute reinstall (#10630).
    if (status === "installation" && error instanceof AdbCommandTimeoutError) {
      throw toActionableError(
        error,
        "CtrlProxy install status check timed out; the device may be overloaded, retry device acquisition",
      );
    }
    logger.warn(`[CTRL_PROXY] Error checking ${status} status: ${error}`);
    return false;
  }

  /**
   * Check if Accessibility Service is enabled for a specific user profile
   * @param userId - The Android user ID to check (e.g., 10 for work profile)
   */
  async isEnabledForUser(userId: number): Promise<boolean> {
    try {
      logger.debug(`[CTRL_PROXY] Checking if accessibility service is enabled for user ${userId}`);
      const result = await this.host.adb.executeCommand(
        `shell settings --user ${userId} get secure enabled_accessibility_services`,
      );
      const isEnabled = result.stdout.includes(CTRL_PROXY_PACKAGE);
      logger.debug(
        `[CTRL_PROXY] Service enabled status for user ${userId}: ${isEnabled ? "enabled" : "disabled"}`,
      );
      return isEnabled;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error checking enabled status for user ${userId}: ${error}`);
      return false;
    }
  }

  /**
   * Check if the accessibility service is both installed and enabled
   * @returns Promise<boolean> - True if available for use, false otherwise
   */
  async isAvailable(): Promise<boolean> {
    const startTime = this.host.timer.now();

    // Check cache first
    if (this.host.cachedAvailability) {
      const cacheAge = this.host.timer.now() - this.host.cachedAvailability.timestamp;
      const ttl = this.host.cachedAvailability.isAvailable
        ? AndroidCtrlProxyAccessibility.AVAILABILITY_CACHE_TTL
        : AndroidCtrlProxyAccessibility.NEGATIVE_CACHE_TTL;
      if (cacheAge < ttl) {
        logger.debug(
          `[CTRL_PROXY] Using cached overall availability (age: ${cacheAge}ms): ${this.host.cachedAvailability.isAvailable}`,
        );
        return this.host.cachedAvailability.isAvailable;
      } else {
        this.host.cachedAvailability = null;
      }
    }

    logger.debug(`[CTRL_PROXY] Checking availability (no cached result available)`);

    try {
      // Check installation and enabled status in parallel for better performance
      const [installed, enabled] = await Promise.all([
        this.host.isInstalled(),
        this.host.isEnabled(),
      ]);

      const available = installed && enabled;
      const duration = this.host.timer.now() - startTime;

      if (available) {
        const timestamp = this.host.timer.now();
        this.cachedInstallation = { isInstalled: true, timestamp };
        this.cachedEnabled = { isEnabled: true, timestamp };
      }

      // Cache the result
      this.host.cachedAvailability = {
        isAvailable: available,
        timestamp: this.host.timer.now(),
      };

      logger.debug(
        `[CTRL_PROXY] Availability check completed in ${duration}ms - Available: ${available} (cached for ${AndroidCtrlProxyAccessibility.AVAILABILITY_CACHE_TTL / 1000 / 60} minutes)`,
      );
      return available;
    } catch (error) {
      const duration = this.host.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Availability check failed after ${duration}ms: ${error}`);

      // Clear cache on error
      this.host.cachedAvailability = null;

      const deviceError = this.host.statusInspectionDeviceError(error);
      if (deviceError) {
        throw deviceError;
      }
      return false;
    }
  }

  /**
   * Enable Accessibility Service via adb settings commands
   */
  async enableViaSettings(): Promise<void> {
    await this.host.assertNotDrivenByOtherDaemon();
    // Check if settings toggle is supported
    const capabilities = await this.host.getToggleCapabilities();
    if (!capabilities.supportsSettingsToggle) {
      const errorMsg = `Settings-based accessibility toggle is not supported on this device. ${capabilities.reason || ""}`;
      logger.error("[CTRL_PROXY] " + errorMsg, { capabilities });
      throw new Error(errorMsg);
    }

    const user = await this.host.setupUser();
    try {
      logger.info("Enabling Accessibility Service via settings commands");
      const perf = createGlobalPerformanceTracker();

      // Get current enabled services
      perf.startOperation("readCurrentServices");
      const result = await this.host.adb.executeCommand(
        settingsCommand(user, "get secure enabled_accessibility_services"),
      );
      perf.endOperation("readCurrentServices");
      let currentServices = result.stdout.trim();

      // Issue #384: preserve existing enabled services; settings may return "null" or empty.
      if (currentServices === "null" || currentServices === "") {
        currentServices = "";
      }

      // Build the service component name
      const serviceComponent = `${CTRL_PROXY_PACKAGE}/${CTRL_PROXY_PACKAGE}.CtrlProxy`;

      // Check if service is already in the list
      perf.startOperation("writeServiceEnabled");
      if (currentServices.includes(serviceComponent)) {
        logger.info("Accessibility Service is already enabled");
      } else {
        // Issue #384: append to the colon-separated list instead of overwriting other services.
        const updatedServices = currentServices
          ? `${currentServices}:${serviceComponent}`
          : serviceComponent;

        // Set updated list
        await this.host.adb.executeCommand(
          settingsCommand(user, `put secure enabled_accessibility_services "${updatedServices}"`),
        );
        logger.info("Added AutoMobile service to enabled_accessibility_services");
      }

      // Enable accessibility globally
      await this.host.adb.executeCommand(
        settingsCommand(user, "put secure accessibility_enabled 1"),
      );
      perf.endOperation("writeServiceEnabled");
      logger.info("Accessibility Service enabled successfully via settings");
    } catch (error) {
      this.throwEnableSettingsError(error);
    } finally {
      // Issue #4192: clear in `finally` so success, early return, and a partial
      // failure all reconcile our cached view. clearAvailabilityCache also
      // invalidates the accessibility detector cache, so observe cannot keep
      // reporting the pre-mutation state.
      this.host.clearAvailabilityCache();
    }
  }

  private throwEnableSettingsError(error: unknown): never {
    const deviceError = this.host.statusInspectionDeviceError(error);
    if (deviceError) {
      throw deviceError;
    }
    const errorMsg = errorMessage(error);
    const errorLower = errorMsg.toLowerCase();

    // Categorize error types for clearer feedback
    if (errorLower.includes("permission denied") || errorLower.includes("not permitted")) {
      throw new Error(
        `Permission denied while enabling Accessibility Service. The device may require root access, device owner status, or special shell permissions. Original error: ${errorMsg}`,
      );
    } else if (
      errorLower.includes("device not found") ||
      errorLower.includes("no devices") ||
      errorLower.includes("offline")
    ) {
      throw new Error(
        `Device connection lost while enabling Accessibility Service. Ensure the device is connected and adb is responsive. Original error: ${errorMsg}`,
      );
    } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
      throw new Error(
        `Timeout while enabling Accessibility Service. The device may be unresponsive. Original error: ${errorMsg}`,
      );
    } else {
      throw new Error(
        `Failed to enable Accessibility Service via settings. This may indicate an ADB communication issue or device state problem. Original error: ${errorMsg}`,
      );
    }
  }

  /**
   * Disable Accessibility Service via adb settings commands
   */
  async disableViaSettings(): Promise<void> {
    await this.host.assertNotDrivenByOtherDaemon();
    // Check if settings toggle is supported
    const capabilities = await this.host.getToggleCapabilities();
    if (!capabilities.supportsSettingsToggle) {
      const errorMsg = `Settings-based accessibility toggle is not supported on this device. ${capabilities.reason || ""}`;
      logger.error("[CTRL_PROXY] " + errorMsg, { capabilities });
      throw new Error(errorMsg);
    }

    const user = await this.host.setupUser();
    try {
      logger.info("Disabling Accessibility Service via settings commands");

      // Get current enabled services
      const result = await this.host.adb.executeCommand(
        settingsCommand(user, "get secure enabled_accessibility_services"),
      );
      const currentServices = result.stdout.trim();

      // Handle null or empty values
      if (currentServices === "null" || currentServices === "") {
        logger.info("No accessibility services enabled");
        return;
      }

      // Parse service list
      // Issue #384: remove only the AutoMobile entry and preserve all other enabled services.
      const serviceList = currentServices.split(":");

      // Remove AutoMobile service from list
      const filteredServices = serviceList.filter(
        (service) => !service.includes(CTRL_PROXY_PACKAGE),
      );

      // Check if service was in the list
      if (filteredServices.length === serviceList.length) {
        logger.info("Accessibility Service was not enabled");
      } else {
        // Set updated list
        const updatedServices = filteredServices.join(":");
        await this.host.adb.executeCommand(
          settingsCommand(user, `put secure enabled_accessibility_services "${updatedServices}"`),
        );
        logger.info("Removed AutoMobile service from enabled_accessibility_services");

        // Conditionally disable accessibility if no other services remain
        // Edge case: a trailing separator can yield [""]; treat it as no remaining services.
        if (
          filteredServices.length === 0 ||
          (filteredServices.length === 1 && filteredServices[0] === "")
        ) {
          await this.host.adb.executeCommand(
            settingsCommand(user, "put secure accessibility_enabled 0"),
          );
          logger.info("Disabled accessibility globally (no other services remain)");
        }
      }

      logger.info("Accessibility Service disabled successfully via settings");
    } catch (error) {
      this.throwDisableSettingsError(error);
    } finally {
      // Issue #4192: the disable path previously invalidated nothing, so observe
      // kept reporting accessibility as available after the service was torn down.
      // `finally` covers the early return (no services enabled) and a partial
      // failure as well as the success path.
      this.host.clearAvailabilityCache();
    }
  }

  private throwDisableSettingsError(error: unknown): never {
    const deviceError = this.host.statusInspectionDeviceError(error);
    if (deviceError) {
      throw deviceError;
    }
    const errorMsg = errorMessage(error);
    const errorLower = errorMsg.toLowerCase();

    // Categorize error types for clearer feedback
    if (errorLower.includes("permission denied") || errorLower.includes("not permitted")) {
      throw new Error(
        `Permission denied while disabling Accessibility Service. The device may require root access, device owner status, or special shell permissions. Original error: ${errorMsg}`,
      );
    } else if (
      errorLower.includes("device not found") ||
      errorLower.includes("no devices") ||
      errorLower.includes("offline")
    ) {
      throw new Error(
        `Device connection lost while disabling Accessibility Service. Ensure the device is connected and adb is responsive. Original error: ${errorMsg}`,
      );
    } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
      throw new Error(
        `Timeout while disabling Accessibility Service. The device may be unresponsive. Original error: ${errorMsg}`,
      );
    } else {
      throw new Error(
        `Failed to disable Accessibility Service via settings. This may indicate an ADB communication issue or device state problem. Original error: ${errorMsg}`,
      );
    }
  }

  /**
   * Enable Accessibility Service
   */
  async enable(): Promise<void> {
    return this.host.enableViaSettings();
  }

  /**
   * Enable Accessibility Service for a specific user profile via adb settings commands
   * @param userId - The Android user ID to enable for (e.g., 10 for work profile)
   */
  async enableForUser(userId: number): Promise<void> {
    await this.host.assertNotDrivenByOtherDaemon();
    // Check if settings toggle is supported
    const capabilities = await this.host.getToggleCapabilities();
    if (!capabilities.supportsSettingsToggle) {
      const errorMsg = `Settings-based accessibility toggle is not supported on this device. ${capabilities.reason || ""}`;
      logger.error("[CTRL_PROXY] " + errorMsg, { capabilities });
      throw new Error(errorMsg);
    }

    try {
      logger.info(
        `[CTRL_PROXY] Enabling Accessibility Service via settings commands for user ${userId}`,
      );

      // Get current enabled services for this user
      const result = await this.host.adb.executeCommand(
        `shell settings --user ${userId} get secure enabled_accessibility_services`,
      );
      let currentServices = result.stdout.trim();

      // Issue #384: preserve existing enabled services; settings may return "null" or empty.
      if (currentServices === "null" || currentServices === "") {
        currentServices = "";
      }

      // Build the service component name
      const serviceComponent = `${CTRL_PROXY_PACKAGE}/${CTRL_PROXY_PACKAGE}.CtrlProxy`;

      // Check if service is already in the list
      if (currentServices.includes(serviceComponent)) {
        logger.info(`[CTRL_PROXY] Accessibility Service is already enabled for user ${userId}`);
      } else {
        // Issue #384: append to the colon-separated list instead of overwriting other services.
        const updatedServices = currentServices
          ? `${currentServices}:${serviceComponent}`
          : serviceComponent;

        // Set updated list
        await this.host.adb.executeCommand(
          `shell settings --user ${userId} put secure enabled_accessibility_services "${updatedServices}"`,
        );
        logger.info(
          `[CTRL_PROXY] Added AutoMobile service to enabled_accessibility_services for user ${userId}`,
        );
      }

      // Enable accessibility globally for this user
      await this.host.adb.executeCommand(
        `shell settings --user ${userId} put secure accessibility_enabled 1`,
      );
      logger.info(
        `[CTRL_PROXY] Accessibility Service enabled successfully via settings for user ${userId}`,
      );
    } catch (error) {
      this.throwEnableUserError(error, userId);
    } finally {
      // Issue #4192: main-user cache only (per-user caching not implemented);
      // `finally` also covers the partial-failure path.
      this.host.clearAvailabilityCache();
    }
  }

  private throwEnableUserError(error: unknown, userId: number): never {
    const deviceError = this.host.statusInspectionDeviceError(error);
    if (deviceError) {
      throw deviceError;
    }
    const errorMsg = errorMessage(error);
    const errorLower = errorMsg.toLowerCase();

    // Categorize error types for clearer feedback
    if (errorLower.includes("permission denied") || errorLower.includes("not permitted")) {
      throw new Error(
        `Permission denied while enabling Accessibility Service for user ${userId}. The device may require root access, device owner status, or special shell permissions. Original error: ${errorMsg}`,
      );
    } else if (
      errorLower.includes("device not found") ||
      errorLower.includes("no devices") ||
      errorLower.includes("offline")
    ) {
      throw new Error(
        `Device connection lost while enabling Accessibility Service for user ${userId}. Ensure the device is connected and adb is responsive. Original error: ${errorMsg}`,
      );
    } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
      throw new Error(
        `Timeout while enabling Accessibility Service for user ${userId}. The device may be unresponsive. Original error: ${errorMsg}`,
      );
    } else {
      throw new Error(
        `Failed to enable Accessibility Service via settings for user ${userId}. This may indicate an ADB communication issue or device state problem. Original error: ${errorMsg}`,
      );
    }
  }

  /**
   * Detect if device is an emulator or physical device
   * Returns [isEmulator, hadError] tuple to track detection success
   */
  private async isEmulator(): Promise<[boolean, boolean]> {
    try {
      const traits = await this.host.readDeviceTraits();
      if (traits.isEmulator === true) {
        return [true, false];
      }

      // Fallback: check the model for common emulator strings
      const model = traits.model?.toLowerCase() ?? "";
      return [model.includes("emulator") || model.includes("sdk"), false];
    } catch (error) {
      const deviceError = this.host.statusInspectionDeviceError(error);
      if (deviceError) {
        throw deviceError;
      }
      logger.warn("[CTRL_PROXY] Error detecting device type", { error });
      // Default to physical device on error (more conservative), but mark as errored
      return [false, true];
    }
  }

  /**
   * Get device API level
   * Returns [apiLevel, hadError] tuple to track detection success
   */
  async getApiLevel(): Promise<[number | null, boolean]> {
    try {
      const result = await this.host.adb.executeCommand("shell getprop ro.build.version.sdk", {
        noRetry: true,
      });
      const apiLevel = parseInt(result.stdout.trim(), 10);
      return [isNaN(apiLevel) ? null : apiLevel, false];
    } catch (error) {
      const deviceError = this.host.statusInspectionDeviceError(error);
      if (deviceError) {
        throw deviceError;
      }
      logger.warn("[CTRL_PROXY] Error getting API level", { error });
      return [null, true];
    }
  }

  /**
   * Check if the device supports programmatic accessibility toggle via settings commands
   * @returns Promise<boolean> - True if settings-based toggle is supported
   */
  async canUseSettingsToggle(): Promise<boolean> {
    const capabilities = await this.host.getToggleCapabilities();
    return capabilities.supportsSettingsToggle;
  }

  /**
   * Get detailed capabilities for accessibility service toggling
   * @returns Promise<ToggleCapabilities> - Capability information including device type and reason if unavailable
   */
  async getToggleCapabilities(): Promise<ToggleCapabilities> {
    // Return cached result if available
    if (this.cachedToggleCapabilities) {
      logger.info("[CTRL_PROXY] Using cached toggle capabilities");
      return this.cachedToggleCapabilities;
    }

    logger.info("[CTRL_PROXY] Detecting toggle capabilities");

    const [isEmulator, emulatorDetectionError] = await this.isEmulator();
    const [apiLevel, apiLevelDetectionError] = await this.host.getApiLevel();
    const deviceType = isEmulator ? "emulator" : "physical";

    let supportsSettingsToggle = false;
    let reason: string | undefined;

    // If we had detection errors, don't make definitive claims about support
    const hadDetectionError = emulatorDetectionError || apiLevelDetectionError;

    if (hadDetectionError) {
      supportsSettingsToggle = false;
      reason = "Unable to detect device capabilities due to transient error. Retry may succeed.";
      logger.warn("[CTRL_PROXY] Detection error - not caching result", {
        emulatorDetectionError,
        apiLevelDetectionError,
      });
    } else if (isEmulator) {
      // Emulators generally support settings-based toggle
      supportsSettingsToggle = true;
      logger.info("[CTRL_PROXY] Emulator detected - settings toggle supported");
    } else {
      // Physical devices may require special permissions
      supportsSettingsToggle = false;
      reason =
        "Physical devices may require root, device owner status, or special shell permissions for programmatic accessibility toggle";
      logger.info("[CTRL_PROXY] Physical device detected - settings toggle may not be supported", {
        reason,
      });
    }

    // Additional API level checks could be added here if needed
    if (!hadDetectionError && apiLevel !== null && apiLevel < 16) {
      supportsSettingsToggle = false;
      reason = `API level ${apiLevel} is too old (requires API 16+)`;
      logger.warn("[CTRL_PROXY] API level too old for settings toggle", { apiLevel });
    }

    const capabilities: ToggleCapabilities = {
      supportsSettingsToggle,
      deviceType,
      apiLevel,
      reason,
    };

    // Only cache if we successfully detected capabilities without errors
    // This prevents transient errors from creating sticky false negatives
    if (!hadDetectionError) {
      this.cachedToggleCapabilities = capabilities;
      logger.info("[CTRL_PROXY] Toggle capabilities detected and cached", capabilities);
    } else {
      logger.info(
        "[CTRL_PROXY] Toggle capabilities detected but not cached due to detection errors",
        capabilities,
      );
    }

    return capabilities;
  }
}
