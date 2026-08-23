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
  ): Promise<boolean> {
    this.callCount++;
    this.isVoiceOverEnabledFeatureFlagsArgs.push(featureFlags);
    this.isVoiceOverEnabledTimeoutMsArgs.push(timeoutMs);
    return this.voiceOverEnabledResults.shift() ?? this.voiceOverEnabled;
  }

  invalidateCache(deviceId: string): void {
    this.invalidatedDevices.push(deviceId);
  }

  clearAllCache(): void {
    this.invalidatedDevices = [];
  }
}
