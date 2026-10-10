import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { registerDeviceTools } from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  installListDevicesFixture,
  type ListDevicesFixture,
} from "../../scripts/benchmark-listdevices-fixture";

type ListedDevice = { runtime: { deviceId: string; poolStatus: string | null; heldBy?: string } };

describe("listDevices benchmark fixture (#11332)", () => {
  let fixture: ListDevicesFixture | undefined;

  beforeAll(() => {
    if (!ToolRegistry.getTool("listDevices")) {
      registerDeviceTools();
    }
  });
  afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
  });
  afterAll(() => {
    fixture?.dispose();
  });

  const list = async () => {
    const response = await ToolRegistry.getTool("listDevices")!.handler({ platform: "android" });
    const content = (response as { content: Array<{ text: string }> }).content;
    return JSON.parse(content[0].text) as {
      devices: ListedDevice[];
      capacity?: { android?: { booted: number } };
      discovery: { complete: boolean };
    };
  };

  test("standalone scenario lists the fake devices without a pool and reports capacity", async () => {
    fixture = await installListDevicesFixture("standalone");
    const payload = await list();
    expect(payload.devices.map((d) => d.runtime.poolStatus)).toEqual([null, null, null]);
    expect(payload.capacity?.android?.booted).toBe(2);
    expect(payload.discovery.complete).toBe(true);
  });

  test("daemon scenario reports the managed-slot and other-daemon holders", async () => {
    fixture = await installListDevicesFixture("daemon");
    const payload = await list();
    expect(payload.devices.map((d) => [d.runtime.deviceId, d.runtime.heldBy])).toEqual([
      ["emulator-5554", "managed_slot"],
      ["emulator-5556", "other_daemon"],
      ["emulator-5558", undefined],
    ]);
    expect(payload.devices[2].runtime.poolStatus).toBe("idle");
  });
});
