import { describe, expect, test } from "bun:test";
import { createDaemonPerformanceDemandProbe } from "../../../src/features/performance/PerformanceDemandProbe";

describe("daemon performance demand", () => {
  test("missing servers have no demand", () => {
    const probe = createDaemonPerformanceDemandProbe({
      getPerformancePushServer: () => null,
      getDeviceDataStreamServer: () => null,
      getTelemetryPushServer: () => null,
    });
    expect(probe.hasDemand("device", "app", "android")).toBe(false);
  });

  test("iOS does not consult the device stream", () => {
    let streamChecks = 0;
    const probe = createDaemonPerformanceDemandProbe({
      getPerformancePushServer: () => null,
      getTelemetryPushServer: () => null,
      getDeviceDataStreamServer: () => {
        streamChecks++;
        return { hasSubscriberForDevice: () => true };
      },
    });
    expect(probe.hasDemand("device", "app", "ios")).toBe(false);
    expect(streamChecks).toBe(0);
    expect(probe.hasDemand("device", "app", "android")).toBe(true);
    expect(streamChecks).toBe(1);
  });

  for (const category of [null, "performance", "network"]) {
    for (const uuid of [null, "device", "other"]) {
      test(`telemetry category=${category}, uuid=${uuid}`, () => {
        const probe = createDaemonPerformanceDemandProbe({
          getPerformancePushServer: () => null,
          getDeviceDataStreamServer: () => null,
          getTelemetryPushServer: () => ({
            getSubscriberCount: () => 1,
            hasSubscriberForPerformanceTelemetry: (deviceId) =>
              (category === null || category === "performance") &&
              (uuid === null || uuid === deviceId),
          }),
        });
        for (const platform of ["android", "ios"] as const) {
          expect(probe.hasDemand("device", "app", platform)).toBe(
            category !== "network" && uuid !== "other",
          );
        }
      });
    }
  }

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
            getTelemetryPushServer: () => ({
              getSubscriberCount: () => (telemetry ? 1 : 0),
              hasSubscriberForPerformanceTelemetry: (deviceId) =>
                telemetry && deviceId === "device",
            }),
          });
          expect(probe.hasDemand("device", "app", "android")).toBe(
            performance || stream || telemetry,
          );
          expect(probe.hasDemand("device", "app", "ios")).toBe(performance || telemetry);
          expect(probe.hasDemand("other", "app", "android")).toBe(false);
          expect(probe.hasDemand("device", "other", "android")).toBe(stream || telemetry);
        });
      }
    }
  }
});
