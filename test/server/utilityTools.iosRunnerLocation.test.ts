import { describe, expect, test } from "bun:test";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const physical: BootedDevice = {
  name: "iPhone",
  platform: "ios",
  deviceId: "00008110-001A2B3C4D5E801E",
};

async function setLocation(
  location: Record<string, unknown> = { mode: "static", latitude: 37.33, longitude: -122.03 },
): Promise<Record<string, unknown>> {
  const response = await ToolRegistry.getTool("setDeviceState")!.deviceAwareHandler!(physical, {
    location,
  });
  return JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
}

describe("setDeviceState physical iOS location wiring (#14091)", () => {
  test("the composition root's runner resolver carries the fix", async () => {
    const runner = new FakeIOSCtrlProxy();
    const resolved: string[] = [];
    registerUtilityTools({
      iosRunnerLocation: (device) => {
        resolved.push(device.deviceId);
        return runner;
      },
    });

    const result = await setLocation();

    expect(resolved).toEqual([physical.deviceId]);
    expect(runner.locationHistory).toEqual([{ latitude: 37.33, longitude: -122.03 }]);
    expect(result.location).toMatchObject({ supported: true, method: "ios_ctrl_proxy" });
  });

  test("without a resolver physical iOS location is reported unsupported", async () => {
    registerUtilityTools();

    const result = await setLocation();

    expect(result.location).toMatchObject({ supported: false, method: "ios_ctrl_proxy" });
    expect(String((result.location as { error?: string }).error)).toContain(
      "not available from this entry point",
    );
  });

  test("without a resolver a physical iOS route is refused before it starts", async () => {
    registerUtilityTools();

    const result = await setLocation({
      mode: "route",
      waypoints: [
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 1 },
      ],
      durationMs: 1000,
    });

    expect(result.location).toMatchObject({ supported: false, method: "ios_ctrl_proxy" });
  });
});
