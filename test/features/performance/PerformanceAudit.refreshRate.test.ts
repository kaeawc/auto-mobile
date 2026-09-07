import { describe, expect, test } from "bun:test";
import { PerformanceAudit } from "../../../src/features/performance/PerformanceAudit";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";

/**
 * Issue #6252: `calculateFrameRate` read `capabilities.refreshRateHz`, a field
 * that does not exist on `DeviceCapabilities` (the real field is `refreshRate`).
 * The lookup was always `undefined`, so the `|| 60` fallback silently forced
 * every device — 90Hz and 120Hz panels included — to a 60Hz frame-rate cap,
 * regardless of what `detectRefreshRate` actually found.
 */
describe("PerformanceAudit frame-rate refresh-rate cap (#6252)", function () {
  const device = { deviceId: "test-device", name: "test", platform: "android" as const };
  const packageName = "com.test.app";

  test("caps calculated FPS at the device's real detected refresh rate (120Hz), not a hardcoded 60", async function () {
    const fakeAdbClient = new FakeAdbClient();
    fakeAdbClient.setCommandResult(
      "shell dumpsys display | grep mRefreshRate",
      "mRefreshRate=120.0",
    );
    fakeAdbClient.setCommandResult(
      `shell dumpsys gfxinfo ${packageName}`,
      [
        "Total frames rendered: 500",
        "Janky frames: 5 (1.00%)",
        "50th percentile: 4ms",
        "90th percentile: 6ms",
        "95th percentile: 7ms",
        "99th percentile: 9ms",
      ].join("\n"),
    );
    const adbFactory = new FakeAdbClientFactory(fakeAdbClient);
    const audit = new PerformanceAudit(device, adbFactory);

    const metrics = await audit.collectMetrics(packageName, undefined, undefined, {
      skipTouchLatency: true,
    });

    // p50=4ms -> 1000/4 = 250fps uncapped; must be capped at the real 120Hz
    // refresh rate, not the previous hardcoded 60Hz fallback.
    expect(metrics.frameRateFps).toBe(120);
  });
});
