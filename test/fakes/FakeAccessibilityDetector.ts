import type {
  AccessibilityDetector,
  AccessibilityService,
} from "../../src/utils/interfaces/AccessibilityDetector";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";

/**
 * Fake implementation of AccessibilityDetector for testing
 * Allows configuring detection results without real device interaction
 */
export class FakeAccessibilityDetector implements AccessibilityDetector {
  private detectionResults: Map<string, { enabled: boolean; service: AccessibilityService }> =
    new Map();
  private defaultResult: { enabled: boolean; service: AccessibilityService } = {
    enabled: false,
    service: "unknown",
  };
  private detectionCallCount = 0;
  private invalidatedDevices: string[] = [];
  private invalidationCountAtFirstDetection: number | null = null;
  private detectMethodQueue: AccessibilityService[] = [];

  /** Records the `adb` argument passed to each detectMethod call (regression guard for #3915). */
  public readonly detectMethodAdbArgs: Array<AdbExecutor | null | undefined> = [];

  /** Records the `featureFlags` argument passed to each detectMethod call (regression guard for #3925). */
  public readonly detectMethodFeatureFlagsArgs: Array<FeatureFlagService | undefined> = [];

  /**
   * Configure the detection result for a specific device
   */
  setDetectionResult(
    deviceId: string,
    enabled: boolean,
    service: AccessibilityService = "talkback",
  ): void {
    this.detectionResults.set(deviceId, { enabled, service });
  }

  /**
   * Configure the default detection result for all devices
   */
  setDefaultResult(enabled: boolean, service: AccessibilityService = "unknown"): void {
    this.defaultResult = { enabled, service };
  }

  /**
   * Queue a sequence of `detectMethod` results consumed in FIFO order; once the
   * queue is exhausted, detection falls back to the per-device / default result.
   * Lets a test model a state transition across the two detections a toggle now
   * performs — the pre-apply idempotency check and the post-apply confirmation
   * (#3921). Only affects `detectMethod`; `isAccessibilityEnabled` is unchanged.
   */
  enqueueDetectMethodResults(...services: AccessibilityService[]): void {
    this.detectMethodQueue.push(...services);
  }

  /**
   * Get the number of times detection was called
   */
  getDetectionCallCount(): number {
    return this.detectionCallCount;
  }

  /**
   * Alias for getDetectionCallCount for test compatibility
   */
  getCheckCount(): number {
    return this.detectionCallCount;
  }

  /**
   * Helper method to set TalkBack enabled/disabled state for default device
   */
  setTalkBackEnabled(enabled: boolean): void {
    this.setDefaultResult(enabled, enabled ? "talkback" : "unknown");
  }

  /**
   * Get the list of devices that had their cache invalidated
   */
  getInvalidatedDevices(): string[] {
    return [...this.invalidatedDevices];
  }

  /**
   * Returns the number of invalidateCache calls that had occurred before the
   * first detectMethod call.  Useful for verifying cache-before-check ordering.
   */
  getInvalidationCountBeforeFirstDetection(): number {
    return this.invalidationCountAtFirstDetection ?? 0;
  }

  /**
   * Reset fake state
   */
  reset(): void {
    this.detectionResults.clear();
    this.defaultResult = { enabled: false, service: "unknown" };
    this.detectionCallCount = 0;
    this.invalidatedDevices = [];
    this.invalidationCountAtFirstDetection = null;
    this.detectMethodAdbArgs.length = 0;
    this.detectMethodFeatureFlagsArgs.length = 0;
    this.detectMethodQueue.length = 0;
  }

  async isAccessibilityEnabled(
    deviceId: string,
    _adb: AdbExecutor,
    _featureFlags?: FeatureFlagService,
  ): Promise<boolean> {
    this.detectionCallCount++;
    const result = this.detectionResults.get(deviceId) || this.defaultResult;
    return result.enabled;
  }

  async detectMethod(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<AccessibilityService> {
    this.detectMethodAdbArgs.push(adb);
    this.detectMethodFeatureFlagsArgs.push(featureFlags);
    if (this.invalidationCountAtFirstDetection === null) {
      this.invalidationCountAtFirstDetection = this.invalidatedDevices.length;
    }
    this.detectionCallCount++;
    if (this.detectMethodQueue.length > 0) {
      return this.detectMethodQueue.shift()!;
    }
    const result = this.detectionResults.get(deviceId) || this.defaultResult;
    return result.service;
  }

  invalidateCache(deviceId: string): void {
    this.invalidatedDevices.push(deviceId);
  }

  clearAllCache(): void {
    this.detectionResults.clear();
  }
}
