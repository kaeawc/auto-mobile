import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  runSessionDisplayPin,
  type SessionDisplayPinStore,
} from "../../src/server/sessionDisplayPin";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

const dualPanels: BootedDevice["displays"] = {
  panels: [
    { key: "inside", role: "inner", sizePx: { width: 200, height: 200 } },
    { key: "outside", role: "cover", sizePx: { width: 100, height: 100 } },
  ],
  postures: ["opened", "closed"],
};

function pinnedTo(deviceId: string, pin: string | undefined): SessionDisplayPinStore {
  return {
    getDeviceForSession: () => deviceId,
    getDisplayPin: () => pin,
  };
}

async function pressArgs(
  device: BootedDevice,
  args: Record<string, unknown>,
  pin: string | undefined,
): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> = {};
  await runSessionDisplayPin({
    name: "pressButton",
    acceptsDisplay: true,
    device,
    args,
    sessionUuid: "session",
    store: pinnedTo(device.deviceId, pin),
    invoke: (effective) => {
      seen = effective;
      return createStructuredToolResponse({ success: true });
    },
  });
  return seen;
}

describe("pressButton session display pin (#17643)", () => {
  const android: BootedDevice = {
    deviceId: "car",
    name: "Car",
    platform: "android",
    displays: dualPanels,
  };

  test("a pin supplies display when the call omits it", async () => {
    expect(await pressArgs(android, { button: "back" }, "outside")).toEqual({
      button: "back",
      display: "outside",
    });
  });

  test("an explicit display overrides the pin", async () => {
    expect(await pressArgs(android, { button: "back", display: "inside" }, "outside")).toEqual({
      button: "back",
      display: "inside",
    });
  });

  test("without a pin the arguments are unchanged", async () => {
    expect(await pressArgs(android, { button: "back" }, undefined)).toEqual({ button: "back" });
  });

  test("a single-panel pin keeps the ordinary press, as tapOn does", async () => {
    const phone: BootedDevice = {
      ...android,
      displays: { panels: [dualPanels.panels[0]], postures: [] },
    };
    expect(await pressArgs(phone, { button: "back" }, "inside")).toEqual({ button: "back" });
  });

  test("a pin is not applied off Android, where pressButton has no display routing", async () => {
    const ios: BootedDevice = { ...android, platform: "ios" };
    expect(await pressArgs(ios, { button: "home" }, "outside")).toEqual({ button: "home" });
  });

  test.each(["lock", "power", "volume_up", "volume_down", "rotary_rotate_cw", "rotary_select"])(
    "a pin is not applied to the device-global %s press (#17647)",
    async (button) => {
      expect(await pressArgs(android, { button }, "outside")).toEqual({ button });
    },
  );

  test("a pin to a disconnected panel does not fail a device-global press (#17647)", async () => {
    let invoked: Record<string, unknown> | undefined;
    const response = await runSessionDisplayPin({
      name: "pressButton",
      acceptsDisplay: true,
      device: android,
      args: { button: "volume_up" },
      sessionUuid: "session",
      store: pinnedTo(android.deviceId, "gone"),
      invoke: (effective) => {
        invoked = effective;
        return createStructuredToolResponse({ success: true });
      },
    });
    expect(invoked).toEqual({ button: "volume_up" });
    expect(response).not.toHaveProperty("isError");
  });

  test("a pin to a disconnected panel still fails a display-routed press", async () => {
    let invoked = false;
    const response = await runSessionDisplayPin({
      name: "pressButton",
      acceptsDisplay: true,
      device: android,
      args: { button: "back" },
      sessionUuid: "session",
      store: pinnedTo(android.deviceId, "gone"),
      invoke: () => {
        invoked = true;
        return createStructuredToolResponse({ success: true });
      },
    });
    expect(invoked).toBe(false);
    expect(response).toHaveProperty("isError", true);
  });

  test("an explicit display still reaches a device-global press", async () => {
    expect(
      await pressArgs(android, { button: "rotary_nudge_up", display: "inside" }, "outside"),
    ).toEqual({ button: "rotary_nudge_up", display: "inside" });
  });
});
