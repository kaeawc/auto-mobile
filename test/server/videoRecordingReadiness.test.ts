import { expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  registerVideoRecordingTools,
  type VideoRecordingArgs,
} from "../../src/server/videoRecordingTools";

test("video recording requires CtrlProxy only when startup highlights need it", () => {
  const registry = ToolRegistry as any;
  const originalRegister = registry.registerDeviceAware;
  let readiness: ((args: VideoRecordingArgs) => string) | undefined;

  registry.registerDeviceAware = (...args: any[]) => {
    readiness = args[4]?.deviceReadiness;
  };

  try {
    registerVideoRecordingTools();
  } finally {
    registry.registerDeviceAware = originalRegister;
  }

  expect(readiness).toBeDefined();
  expect(readiness!({ action: "start", platform: "ios" })).toBe("booted");
  expect(
    readiness!({
      action: "start",
      platform: "ios",
      highlights: [{ description: "Tap target" }],
    }),
  ).toBe("automationReady");
  expect(readiness!({ action: "stop", platform: "ios", recordingId: "recording-1" })).toBe(
    "automationReady",
  );
});
