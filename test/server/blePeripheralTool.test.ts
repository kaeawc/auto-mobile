import { describe, expect, test } from "bun:test";
import {
  blePeripheralSchema,
  createBlePeripheralHandler,
} from "../../src/server/blePeripheralTool";
import { blePeripheralFixture, bleStartArgs } from "../helpers/blePeripheralFixture";
import { toolStructured } from "../helpers/toolResponse";

describe("blePeripheral tool contract", () => {
  test.each([
    {},
    { action: "unknown" },
    { action: "start" },
    { action: "start", name: "x", presets: ["custom"] },
    { action: "start", name: "x", presets: ["battery", "battery"] },
    { action: "start", name: "😀".repeat(6), presets: ["battery"] },
    { action: "status" },
    { action: "stop" },
    { action: "notify", handle: "h" },
    { action: "notify", handle: "h", characteristic: "battery", level: 101 },
    { action: "notify", handle: "h", characteristic: "heartRate" },
    {
      action: "notify",
      handle: "h",
      characteristic: "1234",
      value: { value: "abc", encoding: "hex" },
    },
    { action: "notify", handle: "h", characteristic: "not-a-uuid", value: { value: "hello" } },
    { action: "stop", handle: "h", undeclared: true },
  ])("rejects invalid action arguments: %j", (args) => {
    expect(blePeripheralSchema.safeParse(args).success).toBe(false);
  });

  test("accepts custom read/notify GATT and both notification encodings", () => {
    const args = blePeripheralSchema.parse({
      action: "start",
      name: "Lock",
      presets: ["custom"],
      services: [
        {
          uuid: "12345678-0000-1000-8000-00805f9b34fb",
          characteristics: [
            {
              uuid: "12345678-0001-1000-8000-00805f9b34fb",
              properties: ["read", "notify"],
              initialValue: { value: "hello" },
            },
          ],
        },
      ],
    });
    expect(args.services?.[0].characteristics[0].initialValue?.encoding).toBe("utf8");
    for (const value of [
      { value: "hello", encoding: "utf8" },
      { value: "00ff", encoding: "hex" },
    ]) {
      expect(
        blePeripheralSchema.safeParse({
          action: "notify",
          handle: "h",
          characteristic: "1234",
          value,
        }).success,
      ).toBe(true);
    }
  });

  test("handler returns a structured handle and defaults to the session device", async () => {
    const { manager, transports } = blePeripheralFixture();
    const handler = createBlePeripheralHandler({
      manager,
      session: () => ({ sessionUuid: "s1", deviceId: "emulator-5554" }),
    });
    const result = await handler({ ...bleStartArgs(), deviceId: undefined });
    expect(toolStructured(result)).toMatchObject({
      handle: "fake-1",
      running: true,
      pythonReady: true,
    });
    expect(transports.calls[0].deviceId).toBe("emulator-5554");
    const stopped = await handler({ action: "stop", handle: "fake-1" });
    expect(toolStructured(stopped)).toMatchObject({ running: false });
  });

  test("requires a live session and refuses a different session's transport target", async () => {
    const { manager, environments } = blePeripheralFixture();
    await expect(
      createBlePeripheralHandler({ manager, session: () => undefined })(bleStartArgs()),
    ).rejects.toThrow(/live daemon device session/);
    await expect(
      createBlePeripheralHandler({
        manager,
        session: () => ({ sessionUuid: "s1", deviceId: "emulator-5556" }),
      })(bleStartArgs()),
    ).rejects.toThrow(/must match/);
    expect(environments.calls).toBe(0);
  });
});
