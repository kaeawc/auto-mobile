import { expect, spyOn, test } from "bun:test";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../../src/daemon/constants";
import { WakeAndUnlock } from "../../src/features/action/WakeAndUnlock";
import type { BootedDevice } from "../../src/models";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

test("wakeAndUnlock handler forwards the daemon's absolute transport deadline", async () => {
  let handler: Parameters<typeof ToolRegistry.registerDeviceAware>[3] | undefined;
  const registration = spyOn(ToolRegistry, "registerDeviceAware").mockImplementation((...args) => {
    if (args[0] === "wakeAndUnlock") {
      handler = args[3];
    }
  });
  const adb = spyOn(defaultAdbClientFactory, "create").mockReturnValue(new FakeAdbExecutor());
  const calls: unknown[][] = [];
  const execute = spyOn(WakeAndUnlock.prototype, "execute").mockImplementation(async (...args) => {
    calls.push(args);
    return {
      success: true,
      platform: "android",
      wasAsleep: false,
      wasLocked: false,
      unlocked: true,
    };
  });
  try {
    registerInteractionTools();
    expect(handler).toBeDefined();
    const device: BootedDevice = { deviceId: "fake-unlock", platform: "android", name: "Fake" };
    await handler!(device, { pin: "1234", [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 123_000 });
    await handler!(device, {});
    expect(calls).toEqual([
      ["1234", 123_000],
      [undefined, undefined],
    ]);
  } finally {
    registration.mockRestore();
    adb.mockRestore();
    execute.mockRestore();
  }
});
