import { describe, expect, test } from "bun:test";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import { getDeviceStateResultSchema } from "../../../src/server/toolOutputSchemas";
import { deviceStateMessage } from "../../../src/server/deviceStateMessage";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

describe("getDeviceState include sensors (#14114)", () => {
  test("reads emulator sensors through the console and lists refused ones", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDefaultResponse(createExecResult("KO: 'x' is disabled.\n", ""));
    adb.setCommandResponse("emu sensor get light", createExecResult("light = 40\nOK\n", ""));
    adb.setCommandResponse("emu sensor get proximity", createExecResult("proximity = 1\nOK\n", ""));
    const state = new DeviceState(
      { name: "emu", platform: "android", deviceId: "emulator-5554" },
      { adbFactory: new FakeAdbClientFactory(adb) },
    );
    const result = await state.getState(["sensors"]);
    expect(result.success).toBe(true);
    expect(result.sensors?.sensors).toEqual([
      { name: "proximity", value: [1] },
      { name: "light", value: [40] },
    ]);
    expect(result.sensors?.unavailable).toHaveLength(7);
    expect(adb.getExecutedCommands()).toHaveLength(9);
    expect(deviceStateMessage(result)).toBe("2 emulator sensors read");
    getDeviceStateResultSchema.parse({ message: deviceStateMessage(result), ...result });
  });

  test("a physical device reports sensors unsupported without failing the read", async () => {
    const adb = new FakeAdbExecutor();
    const state = new DeviceState(
      { name: "phone", platform: "android", deviceId: "R58M123ABC" },
      { adbFactory: new FakeAdbClientFactory(adb) },
    );
    const result = await state.getState(["sensors"]);
    expect(result.success).toBe(true);
    expect(result.unsupported).toEqual(["sensors"]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
