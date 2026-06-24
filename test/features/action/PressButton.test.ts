import { describe, expect, spyOn, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { BootedDevice } from "../../../src/models";

describe("PressButton", () => {
  const iosDevice: BootedDevice = {
    deviceId: "ios-device",
    platform: "ios",
    name: "iPhone"
  };

  test("ios back delegates to CtrlProxy pressBack", async () => {
    let backCalls = 0;
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async () => {
        backCalls++;
        return { success: true, totalTimeMs: 5 };
      },
      requestPressHome: async () => ({ success: true, totalTimeMs: 5 }),
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 })
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);
      const result = await (pressButton as any).executeiOSButtonPress("back");

      expect(result.success).toBe(true);
      expect(backCalls).toBe(1);
      expect(getInstanceSpy).toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios recent delegates to CtrlProxy recent apps", async () => {
    let recentCalls = 0;
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async () => ({ success: true, totalTimeMs: 5 }),
      requestRecentApps: async () => {
        recentCalls++;
        return { success: true, totalTimeMs: 5 };
      }
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);
      const result = await (pressButton as any).executeiOSButtonPress("recent");

      expect(result.success).toBe(true);
      expect(recentCalls).toBe(1);
      expect(getInstanceSpy).toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios menu remains unsupported", async () => {
    const pressButton = new PressButton(iosDevice);
    const result = await (pressButton as any).executeiOSButtonPress("menu");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported iOS simulator button");
  });
});
