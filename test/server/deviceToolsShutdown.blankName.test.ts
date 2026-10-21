import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { createKillDeviceResponse, withConfirmedName } from "../../src/server/deviceToolsShutdown";

const device: BootedDevice = { name: "Pixel_8", platform: "android", deviceId: "emulator-5556" };

describe("killDevice never reports a blank device name", () => {
  test("a blank confirmed identity keeps the caller's target", () => {
    expect(withConfirmedName(device, "")).toBe(device);
    expect(withConfirmedName(device, "  ")).toBe(device);
    expect(withConfirmedName(device, "Pixel_9").name).toBe("Pixel_9");
  });

  test("the success response names the serial when the target name is blank", () => {
    const response = createKillDeviceResponse(
      { device: { ...device, name: "" }, force: false },
      {},
    );
    const text = JSON.stringify(response);
    expect(text).not.toContain("''");
    expect(text).toContain("emulator-5556");
  });
});
