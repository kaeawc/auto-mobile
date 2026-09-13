import type { IosVoiceOverDetector } from "../../src/utils/interfaces/IosVoiceOverDetector";
import type { IOSCtrlProxy } from "../../src/features/observe/ios";
import type { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";

/**
 * Fake implementation of IosVoiceOverDetector for testing.
 * Allows configuring VoiceOver state without real device interaction.
 */
export class FakeIosVoiceOverDetector implements IosVoiceOverDetector {
  private voiceOverEnabled: boolean = false;
  private readonly voiceOverEnabledResults: boolean[] = [];
  private readonly resolvedStateResults: Array<boolean | null> = [];
  private persistentResolvedState: boolean | null | undefined;
  private callCount: number = 0;
  private invalidatedDevices: string[] = [];

  /** Records the `featureFlags` argument passed to each isVoiceOverEnabled call (regression guard for #3925). */
  public readonly isVoiceOverEnabledFeatureFlagsArgs: Array<FeatureFlagService | undefined> = [];
  /** Records the request budget passed to each detection attempt. */
  public readonly isVoiceOverEnabledTimeoutMsArgs: Array<number | undefined> = [];

  /**
   * Configure VoiceOver enabled state for all devices
   */
  setVoiceOverEnabled(enabled: boolean): void {
    this.voiceOverEnabled = enabled;
  }

  /** Configure successive detection results, falling back to the configured state when exhausted. */
  enqueueVoiceOverEnabledResults(...results: boolean[]): void {
    this.voiceOverEnabledResults.push(...results);
  }

  /** Configure successive tri-state probe results for `resolveState`. */
  enqueueResolvedStateResults(...results: Array<boolean | null>): void {
    this.resolvedStateResults.push(...results);
  }

  /**
   * Configure the tri-state result returned after queued outcomes are consumed.
   * Passing `null` models a persistently unreadable CtrlProxy probe.
   */
  setPersistentResolvedState(result: boolean | null | undefined): void {
    this.persistentResolvedState = result;
  }

  /**
   * Get the number of times isVoiceOverEnabled was called
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Get the list of devices that had their cache invalidated
   */
  getInvalidatedDevices(): string[] {
    return [...this.invalidatedDevices];
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.voiceOverEnabled = false;
    this.voiceOverEnabledResults.length = 0;
    this.resolvedStateResults.length = 0;
    this.persistentResolvedState = undefined;
    this.callCount = 0;
    this.invalidatedDevices = [];
    this.isVoiceOverEnabledFeatureFlagsArgs.length = 0;
    this.isVoiceOverEnabledTimeoutMsArgs.length = 0;
  }

  async isVoiceOverEnabled(
    _deviceId: string,
    _client: IOSCtrlProxy,
    featureFlags?: FeatureFlagService,
    timeoutMs?: number,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    this.callCount++;
    this.isVoiceOverEnabledFeatureFlagsArgs.push(featureFlags);
    this.isVoiceOverEnabledTimeoutMsArgs.push(timeoutMs);
    return this.voiceOverEnabledResults.shift() ?? this.voiceOverEnabled;
  }

  /**
   * Fake tap-bias variant. Tests configure the desired resolved boolean via
   * `setVoiceOverEnabled`/`enqueueVoiceOverEnabledResults` the same way as
   * `isVoiceOverEnabled` — this fake models a resolved outcome, not the
   * indeterminate/confirmed distinction the real detector's two methods
   * diverge on (that distinction is covered at the DefaultIosVoiceOverDetector
   * unit-test level).
   */
  async isVoiceOverActiveOrUnknown(
    _deviceId: string,
    _client: IOSCtrlProxy,
    featureFlags?: FeatureFlagService,
    timeoutMs?: number,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    this.callCount++;
    this.isVoiceOverEnabledFeatureFlagsArgs.push(featureFlags);
    this.isVoiceOverEnabledTimeoutMsArgs.push(timeoutMs);
    return this.voiceOverEnabledResults.shift() ?? this.voiceOverEnabled;
  }

  /**
   * Fake tri-state variant. Tests can enqueue an indeterminate `null` probe
   * independently from the boolean queue used by the legacy detector methods.
   */
  async resolveState(
    _deviceId: string,
    _client: IOSCtrlProxy,
    featureFlags?: FeatureFlagService,
    timeoutMs?: number,
    _signal?: AbortSignal,
  ): Promise<boolean | null> {
    this.callCount++;
    this.isVoiceOverEnabledFeatureFlagsArgs.push(featureFlags);
    this.isVoiceOverEnabledTimeoutMsArgs.push(timeoutMs);
    if (this.resolvedStateResults.length > 0) {
      return this.resolvedStateResults.shift()!;
    }
    const queuedLegacyResult = this.voiceOverEnabledResults.shift();
    if (queuedLegacyResult !== undefined) {
      return queuedLegacyResult;
    }
    if (this.persistentResolvedState !== undefined) {
      return this.persistentResolvedState;
    }
    return this.voiceOverEnabled;
  }

  invalidateCache(deviceId: string): void {
    this.invalidatedDevices.push(deviceId);
  }

  clearAllCache(): void {
    this.invalidatedDevices = [];
  }
}
