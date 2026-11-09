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
});
