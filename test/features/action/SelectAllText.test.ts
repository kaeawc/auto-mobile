import { expect, describe, test, spyOn } from "bun:test";
import { SelectAllText } from "../../../src/features/action/SelectAllText";
import { BootedDevice } from "../../../src/models";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

describe("SelectAllText Android", () => {
  // Regression for https://github.com/kaeawc/auto-mobile/issues/2231.
  // AndroidCtrlProxyClient.getInstance expects an AdbClientFactory and calls
  // `.create(device)` on it. Passing the resolved AdbExecutor instead
  // surfaces in production as `TypeError: <minified>.create is not a function`
  // and silently breaks the a11y selectAll path on first ctrl-proxy call.
  test("passes the injected AdbClientFactory (not AdbExecutor) to AndroidCtrlProxyClient.getInstance", async () => {
    const factory = new FakeAdbClientFactory();
    const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestSelectAll: async () => ({ success: true, totalTimeMs: 1 }),
    } as unknown as AndroidCtrlProxyClient);

    const device: BootedDevice = {
      name: "Test Android",
      platform: "android",
      deviceId: "test-android",
    };

    const selectAllText = new SelectAllText(device, factory);
    const observedSpy = spyOn(
      selectAllText as unknown as { observedInteraction: (fn: () => Promise<unknown>) => Promise<unknown> },
      "observedInteraction"
    ).mockImplementation(async (fn: () => Promise<unknown>) => fn());

    await selectAllText.execute();

    expect(getInstanceSpy).toHaveBeenCalled();
    const [, passedFactory] = getInstanceSpy.mock.calls[0] as [BootedDevice, FakeAdbClientFactory];
    expect(typeof passedFactory.create).toBe("function");
    expect(passedFactory).toBe(factory);
    expect(factory.wasCalledForDevice(device.deviceId)).toBe(true);

    getInstanceSpy.mockRestore();
    observedSpy.mockRestore();
  });
});
