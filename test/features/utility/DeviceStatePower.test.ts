import { describe, expect, test } from "bun:test";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import { PowerRegistry } from "../../../src/features/utility/power/PowerRegistry";
import {
  getDeviceStateResultSchema,
  setDeviceStateResultSchema,
} from "../../../src/server/toolOutputSchemas";
import { deviceStateMessage } from "../../../src/server/deviceStateMessage";
import { powerInputSchema } from "../../../src/features/utility/power/PowerTypes";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakePowerAdb } from "../../fakes/FakePowerAdb";
import { FakeTimer } from "../../fakes/FakeTimer";

function setup() {
  const adb = new FakePowerAdb();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const state = new DeviceState(
    { name: "emu", platform: "android", deviceId: "emulator-5554" },
    {
      adbFactory: new FakeAdbClientFactory(adb),
      timer,
      power: { registry: new PowerRegistry(), target: async () => ({ isEmulator: true, sdk: 34 }) },
    },
  );
  return { adb, state };
}

describe("getDeviceState include power (#14084)", () => {
  test("reads power state and passes the output schema", async () => {
    const { state } = setup();
    const result = await state.getState(["power"]);
    expect(result.success).toBe(true);
    expect(result.power?.battery).toMatchObject({ level: 100, charging: "ac" });
    expect(deviceStateMessage(result)).toBe("Power: battery 100% ac");
    getDeviceStateResultSchema.parse({ message: deviceStateMessage(result), ...result });
  });

  test("setDeviceState power applies, reads back and reports through the result", async () => {
    const { state, adb } = setup();
    adb.setScreenState(true);
    const result = await state.setState({ power: { doze: "deep", batterySaver: true } });
    expect(result.success).toBe(true);
    setDeviceStateResultSchema.parse({ message: "x", ...result });
    expect(result.power?.verified).toBe(true);
    expect(result.power?.preconditions).toEqual([
      "battery unplugged (dumpsys battery unplug)",
      "screen turned off (KEYCODE_SLEEP)",
    ]);
    expect(deviceStateMessage(result)).toContain("deep Doze");
  });

  test("a typed refusal fails the call without applying anything", async () => {
    const { state } = setup();
    const result = await state.setState({ power: { doze: "deep", battery: { charging: "ac" } } });
    expect(result.success).toBe(false);
    expect(result.power?.errorCode).toBe("power_doze_requires_unplugged");
  });

  test("iOS reports power unsupported", async () => {
    const state = new DeviceState({ name: "sim", platform: "ios", deviceId: "SIM-1" });
    const result = await state.getState(["power"]);
    expect(result.unsupported).toEqual(["power"]);
  });
});

describe("powerInputSchema", () => {
  test("validates ranges and shapes", () => {
    expect(powerInputSchema.safeParse({ battery: { level: 101 } }).success).toBe(false);
    expect(powerInputSchema.safeParse({ battery: { level: 1, reset: true } }).success).toBe(false);
    expect(powerInputSchema.safeParse({ battery: {} }).success).toBe(false);
    expect(powerInputSchema.safeParse({}).success).toBe(false);
    expect(powerInputSchema.safeParse({ thermalStatus: 7 }).success).toBe(false);
    expect(powerInputSchema.safeParse({ thermalStatus: "reset" }).success).toBe(true);
    expect(
      powerInputSchema.safeParse({ standbyBucket: { appId: "x", bucket: "rare" } }).success,
    ).toBe(false);
    expect(powerInputSchema.safeParse({ doze: "deep", unknown: 1 }).success).toBe(false);
  });
});
