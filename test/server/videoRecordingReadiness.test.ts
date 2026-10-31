import { expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  registerVideoRecordingTools,
  type VideoRecordingArgs,
} from "../../src/server/videoRecordingTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

test("video recording requires CtrlProxy only when startup highlights need it", () => {
  const registry = ToolRegistry;
  const originalRegister = registry.registerDeviceAware;
  let readiness: ((args: VideoRecordingArgs) => string) | undefined;

  registry.registerDeviceAware = (...args: any[]) => {
    readiness = args[3]?.deviceReadiness;
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
      highlights: [
        {
          description: "Tap target",
          shape: { type: "circle", bounds: { x: 0, y: 0, width: 10, height: 10 } },
        },
      ],
    }),
  ).toBe("automationReady");
  expect(readiness!({ action: "stop", platform: "ios", recordingId: "recording-1" })).toBe(
    "automationReady",
  );
});
