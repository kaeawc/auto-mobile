import { describe, expect, test } from "bun:test";
import { createDaemonPerformanceDemandProbe } from "../../../src/features/performance/PerformanceDemandProbe";

describe("daemon performance demand", () => {
  test("missing servers have no demand", () => {
    const probe = createDaemonPerformanceDemandProbe({
      getPerformancePushServer: () => null,
      getDeviceDataStreamServer: () => null,
      getTelemetryPushServer: () => null,
    });
    expect(probe.hasDemand("device", "app")).toBe(false);
  });

  for (const performance of [false, true]) {
    for (const stream of [false, true]) {
      for (const telemetry of [false, true]) {
        test(`performance=${performance}, stream=${stream}, telemetry=${telemetry}`, () => {
          const probe = createDaemonPerformanceDemandProbe({
            getPerformancePushServer: () => ({
              hasSubscriberForDevice: (deviceId, packageName) =>
                performance && deviceId === "device" && packageName === "app",
            }),
            getDeviceDataStreamServer: () => ({
              hasSubscriberForDevice: (deviceId) => stream && deviceId === "device",
            }),
            getTelemetryPushServer: () => ({ getSubscriberCount: () => (telemetry ? 1 : 0) }),
          });
          expect(probe.hasDemand("device", "app")).toBe(performance || stream || telemetry);
          expect(probe.hasDemand("other", "app")).toBe(telemetry);
          expect(probe.hasDemand("device", "other")).toBe(stream || telemetry);
        });
      }
    }
  }
});
