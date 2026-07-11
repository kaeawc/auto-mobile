import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerBarrierTools } from "../../src/server/barrierTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import type { BootedDevice } from "../../src/models";

const makeDevice = (deviceId: string): BootedDevice => ({
  platform: "android",
  deviceId,
  name: `Device ${deviceId}`,
});

const parseResponse = (response: any): any =>
  JSON.parse(response.content[0].text);

describe("barrier tool", () => {
  beforeAll(() => {
    if (!ToolRegistry.getToolForPlan("barrier")) {
      registerBarrierTools();
    }
  });

  beforeEach(() => {
    CriticalSectionCoordinator.getInstance().reset();
  });

  test("tool is registered with correct schema", () => {
    const tool = ToolRegistry.getToolForPlan("barrier");
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("barrier");
    expect(tool?.description).toContain("proceed concurrently");
    expect(tool?.deviceAwareHandler).toBeDefined();
  });

  test("single device with deviceCount 1 passes the barrier", async () => {
    const tool = ToolRegistry.getToolForPlan("barrier");
    const response = await tool!.deviceAwareHandler!(
      makeDevice("device-1"),
      { lock: "solo", deviceCount: 1 },
      undefined,
      undefined
    );
    const parsed = parseResponse(response);
    expect(parsed.success).toBe(true);
    expect(parsed.lock).toBe("solo");
    expect(parsed.deviceId).toBe("device-1");
    expect(parsed.deviceCount).toBe(1);
  });

  test("two devices synchronize and both pass concurrently", async () => {
    const tool = ToolRegistry.getToolForPlan("barrier");

    const results = await Promise.all([
      tool!.deviceAwareHandler!(
        makeDevice("device-1"),
        { lock: "pair", deviceCount: 2 },
        undefined,
        undefined
      ),
      tool!.deviceAwareHandler!(
        makeDevice("device-2"),
        { lock: "pair", deviceCount: 2 },
        undefined,
        undefined
      ),
    ]);

    const parsed = results.map(parseResponse);
    expect(parsed.every(r => r.success)).toBe(true);
    expect(new Set(parsed.map(r => r.deviceId))).toEqual(
      new Set(["device-1", "device-2"])
    );
  });

  test("rejects with an actionable error on barrier timeout", async () => {
    const tool = ToolRegistry.getToolForPlan("barrier");
    // deviceCount 2 but only one device arrives; short timeout so the test is fast.
    await expect(
      tool!.deviceAwareHandler!(
        makeDevice("device-1"),
        { lock: "lonely", deviceCount: 2, timeout: 50 },
        undefined,
        undefined
      )
    ).rejects.toThrow(/Barrier "lonely" failed for device device-1/);
  });
});
