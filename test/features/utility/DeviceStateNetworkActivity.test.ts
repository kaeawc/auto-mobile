import { describe, expect, test } from "bun:test";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import type { NetworkActivityState } from "../../../src/features/utility/networkActivity/NetworkActivityTypes";
import { readNetworkActivity } from "../../../src/features/utility/networkActivity/NetworkActivityOperations";
import { deviceStateMessage } from "../../../src/server/deviceStateMessage";
import { getDeviceStateResultSchema } from "../../../src/server/toolOutputSchemas";
import type { BootedDevice } from "../../../src/models";

const SIMULATOR: BootedDevice = {
  name: "iPhone 17",
  platform: "ios",
  deviceId: "E32B356F-D6E3-427D-A0CC-2BDA07C5CFCF",
};

const ACTIVITY: NetworkActivityState = {
  supported: true,
  processCount: 310,
  processes: [
    {
      pid: 15965,
      name: "NetProbe",
      appId: "dev.automobile.netprobe19020",
      sockets: [
        {
          protocol: "TCP",
          local: "127.0.0.1:62949",
          remote: "127.0.0.1:47120",
          state: "ESTABLISHED",
        },
      ],
      bytesIn: 2424879,
      bytesOut: 207,
    },
  ],
};

describe("getDeviceState include networkActivity (#19020)", () => {
  test("an iOS Simulator returns the reader's processes", async () => {
    const reads: string[] = [];
    const state = new DeviceState(SIMULATOR, {
      networkActivity: async (device) => {
        reads.push(device.deviceId);
        return ACTIVITY;
      },
    });
    const result = await state.getState(["networkActivity"]);
    expect(result.success).toBe(true);
    expect(result.networkActivity).toEqual(ACTIVITY);
    expect(reads).toEqual([SIMULATOR.deviceId]);
    expect(deviceStateMessage(result)).toBe("Network activity: 1 processes, 1 sockets");
    getDeviceStateResultSchema.parse({ message: deviceStateMessage(result), ...result });
  });

  test("Android reports networkActivity unsupported without reading", async () => {
    let called = false;
    const state = new DeviceState(
      { name: "emu", platform: "android", deviceId: "emulator-5554" },
      {
        networkActivity: async () => {
          called = true;
          return ACTIVITY;
        },
      },
    );
    const result = await state.getState(["networkActivity"]);
    expect(result.success).toBe(true);
    expect(result.unsupported).toEqual(["networkActivity"]);
    expect(called).toBe(false);
  });

  test("a physical iOS device is unsupported", async () => {
    const result = await readNetworkActivity(
      { name: "phone", platform: "ios", deviceId: "00008140-001A2C3E0E12801C" },
      async () => ACTIVITY,
    );
    expect(result).toEqual({ supported: false });
  });

  test("a failed host read becomes a field error and fails the read", async () => {
    const state = new DeviceState(SIMULATOR, {
      networkActivity: async () => {
        throw new Error("nettop: timed out");
      },
    });
    const result = await state.getState(["networkActivity"]);
    expect(result.success).toBe(false);
    expect(result.networkActivity).toEqual({
      supported: true,
      error: "Failed to read network activity: nettop: timed out",
    });
    expect(result.error).toBe("Failed to read network activity: nettop: timed out");
  });
});
