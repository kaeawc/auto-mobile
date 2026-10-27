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

  test("reads accessibility display preferences as raw restorable settings (#14088)", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell getprop ro.build.version.sdk", "34\n");
    client.setCommandResult("shell settings get secure high_text_contrast_enabled", "1\n");
    client.setCommandResult("shell settings get secure font_weight_adjustment", "null\n");
    for (const key of [
      "window_animation_scale",
      "transition_animation_scale",
      "animator_duration_scale",
    ]) {
      client.setCommandResult(`shell settings get global ${key}`, "0.5\n");
    }
    const values = await new DefaultDeviceSettingsAccess(factory).read(device, [
      "increaseContrast",
      "reduceMotion",
      "boldText",
    ]);
    expect(values).toEqual({ increaseContrast: "1", reduceMotion: "0.5,0.5,0.5", boldText: null });
    expect(client.getCommandCalls().map((call) => call.command)).not.toContain(
      "shell cmd uimode night",
    );
  });

  test("restores recorded accessibility display preferences (#14088)", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell getprop ro.build.version.sdk", "34\n");
    const written = await new DefaultDeviceSettingsAccess(factory).write(device, {
      increaseContrast: null,
      reduceMotion: "1.0,null,1.0",
      boldText: "0",
    });
    expect(written).toEqual(["increaseContrast", "reduceMotion", "boldText"]);
    const commands = client.getCommandCalls().map((call) => call.command);
    expect(commands).toContain("shell settings delete secure high_text_contrast_enabled");
    expect(commands).toContain("shell settings put global window_animation_scale 1.0");
    expect(commands).toContain("shell settings delete global transition_animation_scale");
    expect(commands).toContain("shell settings put secure font_weight_adjustment 0");
  });
});
