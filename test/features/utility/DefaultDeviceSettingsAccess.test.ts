import { describe, expect, test } from "bun:test";
import { DefaultDeviceSettingsAccess } from "../../../src/features/utility/DeviceSettingDefaults";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };

describe("DefaultDeviceSettingsAccess (#11145)", () => {
  test("reads Android display settings in their restorable form", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell settings get system font_scale", "null\n");
    client.setCommandResult("shell wm density", "Physical density: 440\nOverride density: 480\n");
    client.setCommandResult("shell cmd uimode night", "Night mode: yes\n");
    const values = await new DefaultDeviceSettingsAccess(factory).read(device, [
      "fontScale",
      "density",
      "nightMode",
    ]);
    expect(values).toEqual({ fontScale: "default", density: 480, nightMode: "dark" });
  });

  test("resets display settings through displayConfig and unsets the 24-hour override", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell settings get system font_scale", "null\n");
    client.setCommandResult("shell wm density", "Physical density: 440\n");
    client.setCommandResult("shell cmd uimode night", "Night mode: no\n");
    const written = await new DefaultDeviceSettingsAccess(factory).write(device, {
      fontScale: "default",
      density: "default",
      nightMode: "light",
      timeFormat: null,
    });
    expect(written).toEqual(["fontScale", "density", "nightMode", "timeFormat"]);
    const commands = client.getCommandCalls().map((call) => call.command);
    expect(commands).toContain("shell settings delete system font_scale");
    expect(commands).toContain("shell wm density reset");
    expect(commands).toContain("shell cmd uimode night no");
    expect(commands).toContain("shell settings delete system time_12_24");
  });
});
