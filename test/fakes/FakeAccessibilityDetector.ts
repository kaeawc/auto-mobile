import type {
  AccessibilityDetector,
  AccessibilityService,
  AndroidAccessibilityState,
  TalkBackStateConfirmation,
} from "../../src/features/accessibility/interfaces/AccessibilityDetector";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { FeatureFlagReader } from "../../src/features/featureFlags/FeatureFlagService";

/**
 * Fake implementation of AccessibilityDetector for testing
 * Allows configuring detection results without real device interaction
 */
export class FakeAccessibilityDetector implements AccessibilityDetector {
  private readonly ctrlProxyResults = new Map<string, boolean | null>();

  setCtrlProxyServiceEnabled(deviceId: string, enabled: boolean | null): void {
    this.ctrlProxyResults.set(deviceId, enabled);
  }

  async isCtrlProxyServiceEnabled(
    deviceId: string,
    adb?: AdbExecutor,
    featureFlags?: FeatureFlagReader,
  ): Promise<boolean | null> {
    // Like the real detector, an auto-detect-disabled flag withholds CtrlProxy evidence.
    if (featureFlags && !featureFlags.isEnabled("accessibility-auto-detect")) {
      return null;
    }
    if (adb) {
      return this.readState(deviceId)?.ctrlProxyEnabled ?? null;
    }
    // The real detector consumes only its cache without an adb; this fake has no cache
    // (the TTL is deliberately unmodelled) so it reports the seeded value.
    return this.ctrlProxyResults.get(deviceId) ?? null;
  }

  private detectionResults: Map<
    string,
    { enabled: boolean | null; service: AccessibilityService }
  > = new Map();
  private defaultResult: { enabled: boolean | null; service: AccessibilityService } = {
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
  public readonly detectMethodFeatureFlagsArgs: Array<FeatureFlagReader | undefined> = [];

  /**
   * Configure the detection result for a specific device
   */
  setDetectionResult(
    deviceId: string,
    enabled: boolean | null,
    service: AccessibilityService = "talkback",
  ): void {
    this.detectionResults.set(deviceId, { enabled, service });
  }

  /**
   * Configure the default detection result for all devices
   */
  setDefaultResult(enabled: boolean | null, service: AccessibilityService = "unknown"): void {
    this.defaultResult = { enabled, service };
  }

  /**
   * Queue a sequence of `detectMethod` results consumed in FIFO order; once the
   * queue is exhausted, detection falls back to the per-device / default result.
   * Lets a test model a state transition across the two detections a toggle now
   * performs — the pre-apply idempotency check and the post-apply confirmation
   * (#3921). Also feeds `resolveState`; `isAccessibilityEnabled` is unchanged.
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
    this.ctrlProxyResults.clear();
    this.detectionResults.clear();
    this.defaultResult = { enabled: false, service: "unknown" };
    this.detectionCallCount = 0;
    this.invalidatedDevices = [];
    this.invalidationCountAtFirstDetection = null;
    this.detectMethodAdbArgs.length = 0;
    this.detectMethodFeatureFlagsArgs.length = 0;
    this.detectMethodQueue.length = 0;
  }

  /** Evidence from the configured result. Not cached: tests flip device state mid-test. */
  private readState(deviceId: string): AndroidAccessibilityState | null {
    const result = this.detectionResults.get(deviceId) ?? this.defaultResult;
    if (result.enabled === null) {
      return null;
    }
    return {
      enabled: result.service === "talkback" || result.enabled,
      service: result.service,
      ctrlProxyEnabled: this.ctrlProxyResults.get(deviceId) ?? null,
    };
  }

  /** Feature-flag short circuits shared by every real detection entry point. */
  private flagState(featureFlags?: FeatureFlagReader): AndroidAccessibilityState | undefined {
    if (featureFlags?.isEnabled("force-accessibility-mode")) {
      return { enabled: true, service: "talkback", ctrlProxyEnabled: null };
    }
    if (featureFlags && !featureFlags.isEnabled("accessibility-auto-detect")) {
      return { enabled: false, service: "unknown", ctrlProxyEnabled: null };
    }
    return undefined;
  }

  async isAccessibilityEnabled(
    deviceId: string,
    _adb: AdbExecutor,
    featureFlags?: FeatureFlagReader,
  ): Promise<boolean> {
    this.detectionCallCount++;
    const state = this.flagState(featureFlags) ?? this.readState(deviceId);
    return state?.enabled ?? false;
  }

  async detectMethod(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagReader,
  ): Promise<AccessibilityService> {
    this.detectMethodAdbArgs.push(adb);
    this.detectMethodFeatureFlagsArgs.push(featureFlags);
    if (this.invalidationCountAtFirstDetection === null) {
      this.invalidationCountAtFirstDetection = this.invalidatedDevices.length;
    }
    this.detectionCallCount++;
    const forced = this.flagState(featureFlags);
    if (forced) {
      return forced.service;
    }
    if (this.detectMethodQueue.length > 0) {
      return this.detectMethodQueue.shift()!;
    }
    return this.readState(deviceId)?.service ?? "unknown";
  }

  async resolveState(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagReader,
  ): Promise<AndroidAccessibilityState | null> {
    const forced = this.flagState(featureFlags);
    const service = await this.detectMethod(deviceId, adb, featureFlags);
    if (forced) {
      return forced;
    }
    const state = this.readState(deviceId);
    if (state === null) {
      return null;
    }
    return { ...state, enabled: service === "talkback" || state.enabled, service };
  }

  async resolveTalkBackState(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagReader,
  ): Promise<boolean | null> {
    return (await this.resolveTalkBackStateWithConfirmation(deviceId, adb, featureFlags)).talkBack;
  }

  async resolveTalkBackStateWithConfirmation(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagReader,
  ): Promise<TalkBackStateConfirmation> {
    const state =
      (await this.resolveState(deviceId, adb, featureFlags)) ??
      (await this.resolveState(deviceId, adb, featureFlags));
    return {
      talkBack: state === null ? null : state.service === "talkback",
      unconfirmed: state === null || state.unconfirmed === true,
    };
  }

  invalidateCache(deviceId: string): void {
    this.invalidatedDevices.push(deviceId);
  }

  clearAllCache(): void {
    // The fake holds no evidence cache (the real TTL is unmodelled), and clearing a
    // cache never changes what the device reports, so keep the configured results.
  }
}
