import { isIosUdid } from "./ios-cmdline-tools/iosDeviceType";
import { logger } from "./logger";

/**
 * Interface for device detection utilities
 */
export type DevicePlatform = "android" | "ios";

export interface DeviceDetection {
  /**
   * Detect device platform based on device ID patterns
   * @param deviceId - The device identifier
   * @returns The detected platform
   */
  detectPlatform(deviceId: string): DevicePlatform;

  /**
   * Check if a device ID represents an iOS device
   * @param deviceId - The device identifier
   * @returns True if iOS device
   */
  isiOSDevice(deviceId: string): boolean;

  /**
   * Check if a device ID represents an Android device
   * @param deviceId - The device identifier
   * @returns True if Android device
   */
  isAndroidDevice(deviceId: string): boolean;
}

/**
 * Device detection utility to determine platform based on device ID
 */
export class DeviceDetection implements DeviceDetection {
  /**
   * Detect device platform based on device ID patterns
   * @param deviceId - The device identifier
   * @returns The detected platform
   */
  detectPlatform(deviceId: string): DevicePlatform {
    if (!deviceId) {
      logger.warn("[DeviceDetection] Empty device ID provided, defaulting to Android");
      return "android";
    }

    // Android device patterns
    // Emulators: emulator-5554, emulator-5556, etc.
    // Physical devices: various patterns like serial numbers
    const androidEmulatorPattern = /^emulator-\d+$/;

    // iOS covers three UDID shapes: the simulator's 8-4-4-4-12 UUID plus the two
    // physical-device forms. Reuse the canonical predicate rather than a second
    // classifier so this stays in step with the simctl/devicectl routing.
    if (isIosUdid(deviceId)) {
      logger.info(`[DeviceDetection] Detected iOS device: ${deviceId}`);
      return "ios";
    }

    // Check for Android emulator pattern
    if (androidEmulatorPattern.test(deviceId)) {
      logger.info(`[DeviceDetection] Detected Android emulator: ${deviceId}`);
      return "android";
    }

    // For other patterns, we'll need additional logic or default to Android
    // Android physical devices can have various ID formats
    // Most non-UUID device IDs are likely Android
    logger.info(`[DeviceDetection] Device ID pattern suggests Android device: ${deviceId}`);
    return "android";
  }

  /**
   * Check if a device ID represents an iOS device
   * @param deviceId - The device identifier
   * @returns True if iOS device
   */
  isiOSDevice(deviceId: string): boolean {
    return this.detectPlatform(deviceId) === "ios";
  }

  /**
   * Check if a device ID represents an Android device
   * @param deviceId - The device identifier
   * @returns True if Android device
   */
  isAndroidDevice(deviceId: string): boolean {
    return this.detectPlatform(deviceId) === "android";
  }

  // Static convenience methods for backward compatibility
  static detectPlatform = (deviceId: string) => new DeviceDetection().detectPlatform(deviceId);
  static isiOSDevice = (deviceId: string) => new DeviceDetection().isiOSDevice(deviceId);
  static isAndroidDevice = (deviceId: string) => new DeviceDetection().isAndroidDevice(deviceId);
}
