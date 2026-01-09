import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DefaultAccessibilityDetector } from "../../src/utils/AccessibilityDetector";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ExecResult } from "../../src/models";

/**
 * Fake ADB client for testing
 */
class FakeAdbClient {
  private responses: Map<string, ExecResult> = new Map();
  private callCount = 0;

  setResponse(deviceId: string, output: string): void {
    this.responses.set(deviceId, {
      stdout: output,
      stderr: "",
      exitCode: 0,
    });
  }

  setError(): void {
    this.responses.set("error", { stdout: "", stderr: "error", exitCode: 1 });
  }

  async shell(_deviceId: string, _command: string): Promise<ExecResult> {
    this.callCount++;
    const response = this.responses.get(_deviceId) || { stdout: "null", stderr: "", exitCode: 0 };

    if (response.exitCode !== 0) {
      throw new Error("ADB error");
    }

    return response;
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.responses.clear();
    this.callCount = 0;
  }
}

/**
 * Fake feature flag service for testing
 */
class FakeFeatureFlagService {
  private flags: Map<string, boolean> = new Map();

  setFlag(key: string, value: boolean): void {
    this.flags.set(key, value);
  }

  isEnabled(key: string): boolean {
    return this.flags.get(key) ?? true;
  }

  reset(): void {
    this.flags.clear();
  }
}

describe("AccessibilityDetector - Unit Tests", () => {
  let detector: DefaultAccessibilityDetector;
  let fakeAdb: FakeAdbClient;
  let fakeFeatureFlags: FakeFeatureFlagService;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    detector = new DefaultAccessibilityDetector(fakeTimer);
    fakeAdb = new FakeAdbClient();
    fakeFeatureFlags = new FakeFeatureFlagService();

    // Clear cache before each test
    detector.clearAllCache();
  });

  afterEach(() => {
    detector.clearAllCache();
    fakeAdb.reset();
    fakeFeatureFlags.reset();
  });

  describe("TalkBack Detection", () => {
    test("detects TalkBack when com.google.android.marvin.talkback is present", async () => {
      fakeAdb.setResponse("device123", "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService");

      const enabled = await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(enabled).toBe(true);

      const service = await detector.detectMethod("device123", fakeAdb as unknown as AdbClient);
      expect(service).toBe("talkback");
    });

    test("detects TalkBack when TalkBackService is present", async () => {
      fakeAdb.setResponse("device123", "com.android.talkback/TalkBackService");

      const enabled = await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(enabled).toBe(true);

      const service = await detector.detectMethod("device123", fakeAdb as unknown as AdbClient);
      expect(service).toBe("talkback");
    });

    test("returns false when no accessibility services are enabled", async () => {
      fakeAdb.setResponse("device123", "null");

      const enabled = await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(enabled).toBe(false);

      const service = await detector.detectMethod("device123", fakeAdb as unknown as AdbClient);
      expect(service).toBe("unknown");
    });

    test("detects unknown accessibility service", async () => {
      fakeAdb.setResponse("device123", "com.example.customservice/CustomAccessibilityService");

      const enabled = await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(enabled).toBe(true);

      const service = await detector.detectMethod("device123", fakeAdb as unknown as AdbClient);
      expect(service).toBe("unknown");
    });
  });

  describe("Caching Behavior", () => {
    test("caches detection result for 60 seconds", async () => {
      fakeAdb.setResponse("device123", "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService");

      // First call
      await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(1);

      // Second call within TTL (should use cache)
      await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(1); // Still 1, not called again

      // Third call (should still use cache)
      const service = await detector.detectMethod("device123", fakeAdb as unknown as AdbClient);
      expect(service).toBe("talkback");
      expect(fakeAdb.getCallCount()).toBe(1); // Still 1
    });

    test("cache expires after TTL using FakeTimer", async () => {
      // Create detector with manual mode timer for time-based testing
      const manualTimer = new FakeTimer();
      manualTimer.setManualMode();
      const timedDetector = new DefaultAccessibilityDetector(manualTimer);

      fakeAdb.setResponse("device123", "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService");

      // First call
      await timedDetector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(1);

      // Advance time by 61 seconds (past TTL)
      manualTimer.advanceTime(61000);

      // Second call after TTL (should call ADB again)
      await timedDetector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(2);
    });

    test("cache does not expire within TTL using FakeTimer", async () => {
      // Create detector with manual mode timer for time-based testing
      const manualTimer = new FakeTimer();
      manualTimer.setManualMode();
      const timedDetector = new DefaultAccessibilityDetector(manualTimer);

      fakeAdb.setResponse("device123", "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService");

      // First call
      await timedDetector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(1);

      // Advance time by 59 seconds (within TTL)
      manualTimer.advanceTime(59000);

      // Second call within TTL (should use cache)
      await timedDetector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(1); // Still cached
    });

    test("invalidateCache clears cache for specific device", async () => {
      fakeAdb.setResponse("device123", "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService");

      // First call
      await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(1);

      // Invalidate cache
      detector.invalidateCache("device123");

      // Second call after invalidation (should call ADB again)
      await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(2);
    });

    test("maintains separate cache per device", async () => {
      fakeAdb.setResponse("device1", "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService");
      fakeAdb.setResponse("device2", "null");

      // Device 1: TalkBack enabled
      const enabled1 = await detector.isAccessibilityEnabled("device1", fakeAdb as unknown as AdbClient);
      expect(enabled1).toBe(true);

      const callCountAfterDevice1 = fakeAdb.getCallCount();

      // Device 2: TalkBack disabled
      const enabled2 = await detector.isAccessibilityEnabled("device2", fakeAdb as unknown as AdbClient);
      expect(enabled2).toBe(false);

      expect(fakeAdb.getCallCount()).toBe(callCountAfterDevice1 + 1);

      // Second calls should use cache
      await detector.isAccessibilityEnabled("device1", fakeAdb as unknown as AdbClient);
      await detector.isAccessibilityEnabled("device2", fakeAdb as unknown as AdbClient);
      expect(fakeAdb.getCallCount()).toBe(callCountAfterDevice1 + 1); // No additional calls
    });
  });

  describe("Feature Flag Overrides", () => {
    test("force-accessibility-mode override returns true", async () => {
      fakeFeatureFlags.setFlag("force-accessibility-mode", true);
      fakeFeatureFlags.setFlag("accessibility-auto-detect", true);

      // Should return true without calling ADB
      const enabled = await detector.isAccessibilityEnabled(
        "device123",
        fakeAdb as unknown as AdbClient,
        fakeFeatureFlags as unknown as FeatureFlagService
      );
      expect(enabled).toBe(true);
      expect(fakeAdb.getCallCount()).toBe(0);

      const service = await detector.detectMethod(
        "device123",
        fakeAdb as unknown as AdbClient,
        fakeFeatureFlags as unknown as FeatureFlagService
      );
      expect(service).toBe("talkback");
    });

    test("accessibility-auto-detect disabled returns false", async () => {
      fakeFeatureFlags.setFlag("force-accessibility-mode", false);
      fakeFeatureFlags.setFlag("accessibility-auto-detect", false);

      // Should return false without calling ADB
      const enabled = await detector.isAccessibilityEnabled(
        "device123",
        fakeAdb as unknown as AdbClient,
        fakeFeatureFlags as unknown as FeatureFlagService
      );
      expect(enabled).toBe(false);
      expect(fakeAdb.getCallCount()).toBe(0);

      const service = await detector.detectMethod(
        "device123",
        fakeAdb as unknown as AdbClient,
        fakeFeatureFlags as unknown as FeatureFlagService
      );
      expect(service).toBe("unknown");
    });

    test("force flag takes precedence over cache", async () => {
      // First call without force flag - cache TalkBack disabled
      fakeAdb.setResponse("device123", "null");
      fakeFeatureFlags.setFlag("force-accessibility-mode", false);
      fakeFeatureFlags.setFlag("accessibility-auto-detect", true);

      const enabled1 = await detector.isAccessibilityEnabled(
        "device123",
        fakeAdb as unknown as AdbClient,
        fakeFeatureFlags as unknown as FeatureFlagService
      );
      expect(enabled1).toBe(false);
      expect(fakeAdb.getCallCount()).toBe(1);

      // Second call with force-enabled - should override cache and return true without ADB call
      fakeFeatureFlags.setFlag("force-accessibility-mode", true);

      const enabled2 = await detector.isAccessibilityEnabled(
        "device123",
        fakeAdb as unknown as AdbClient,
        fakeFeatureFlags as unknown as FeatureFlagService
      );
      expect(enabled2).toBe(true);
      // Should not call ADB again because force flag overrides
      expect(fakeAdb.getCallCount()).toBe(1);
    });
  });

  describe("Error Handling", () => {
    test("gracefully handles ADB errors", async () => {
      fakeAdb.setError();

      // Should return false on error, not throw
      const enabled = await detector.isAccessibilityEnabled("error", fakeAdb as unknown as AdbClient);
      expect(enabled).toBe(false);

      const service = await detector.detectMethod("error", fakeAdb as unknown as AdbClient);
      expect(service).toBe("unknown");
    });

    test("handles empty ADB output", async () => {
      fakeAdb.setResponse("device123", "");

      const enabled = await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      expect(enabled).toBe(false);

      const service = await detector.detectMethod("device123", fakeAdb as unknown as AdbClient);
      expect(service).toBe("unknown");
    });
  });

  describe("Performance with FakeTimer", () => {
    test("detection timing is tracked correctly", async () => {
      fakeAdb.setResponse("device123", "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService");

      const startTime = fakeTimer.now();
      await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      const endTime = fakeTimer.now();

      // FakeTimer tracks time correctly
      expect(endTime).toBeGreaterThanOrEqual(startTime);
    });

    test("cached detection uses no additional time", async () => {
      fakeAdb.setResponse("device123", "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService");

      // First call to populate cache
      await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);

      // Second call should use cache (no time advancement needed)
      const startTime = fakeTimer.now();
      await detector.isAccessibilityEnabled("device123", fakeAdb as unknown as AdbClient);
      const endTime = fakeTimer.now();

      // Time should not advance for cached result
      expect(endTime).toBe(startTime);
    });
  });
});
