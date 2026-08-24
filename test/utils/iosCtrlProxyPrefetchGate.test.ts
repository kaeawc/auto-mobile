import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyBuilder } from "../../src/utils/IOSCtrlProxyBuilder";
import type { PrefetchBuilder } from "../../src/utils/IOSCtrlProxyBuilder";
import type { IosPrerequisiteDetector } from "../../src/utils/ios-cmdline-tools/IosPrerequisiteDetector";

/**
 * Gate for the startup runner-bundle prefetch: it must skip cleanly when iOS
 * prerequisites are absent and still reach the builder when present (#4407).
 */
describe("IOSCtrlProxyBuilder prefetch prerequisite gate", function () {
  let originalPlatform: PropertyDescriptor | undefined;
  let recordingBuilder: PrefetchBuilder & { needsRebuildCalls: number; buildCalls: number };

  const detectorReturning = (value: boolean): IosPrerequisiteDetector => ({
    hasIosPrerequisites: async () => value,
  });

  beforeEach(function () {
    IOSCtrlProxyBuilder.resetInstances();
    // prefetchBuild() early-returns off macOS; force darwin so the gate is what decides.
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    recordingBuilder = {
      needsRebuildCalls: 0,
      buildCalls: 0,
      async needsRebuild() {
        this.needsRebuildCalls++;
        return true;
      },
      async build() {
        this.buildCalls++;
        return { success: true, message: "recorded build" };
      },
      async getBuildProductsPath() {
        return null;
      },
      async getXctestrunPath() {
        return null;
      },
    } as PrefetchBuilder & { needsRebuildCalls: number; buildCalls: number };
    IOSCtrlProxyBuilder.setPrefetchBuilderForTesting(recordingBuilder);
  });

  afterEach(function () {
    IOSCtrlProxyBuilder.resetInstances();
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  test("does not reach the builder when iOS prerequisites are absent", async function () {
    IOSCtrlProxyBuilder.setIosPrerequisiteDetectorForTesting(detectorReturning(false));

    IOSCtrlProxyBuilder.prefetchBuild();
    // Draining the prefetch must resolve null without throwing, so the daemon
    // stays healthy and non-iOS workflows are unaffected.
    const result = await IOSCtrlProxyBuilder.waitForPrefetch();

    expect(result).toBeNull();
    expect(IOSCtrlProxyBuilder.getPrefetchError()).toBeNull();
    expect(recordingBuilder.needsRebuildCalls).toBe(0);
    expect(recordingBuilder.buildCalls).toBe(0);
  });

  test("reaches the builder when iOS prerequisites are present", async function () {
    IOSCtrlProxyBuilder.setIosPrerequisiteDetectorForTesting(detectorReturning(true));

    IOSCtrlProxyBuilder.prefetchBuild();
    await IOSCtrlProxyBuilder.waitForPrefetch();

    // The gate let the prefetch through, so the build path ran.
    expect(recordingBuilder.needsRebuildCalls).toBe(1);
    expect(recordingBuilder.buildCalls).toBe(1);
  });
});
