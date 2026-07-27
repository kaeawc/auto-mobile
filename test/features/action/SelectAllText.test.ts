import { expect, describe, test, spyOn, afterEach } from "bun:test";
import { SelectAllText } from "../../../src/features/action/SelectAllText";
import { BootedDevice } from "../../../src/models";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
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

describe("SelectAllText outcomes", () => {
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let iosGetInstanceSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    iosGetInstanceSpy?.mockRestore();
    getInstanceSpy = null;
    iosGetInstanceSpy = null;
  });

  const androidDevice: BootedDevice = { name: "Android", platform: "android", deviceId: "android-1" };
  const iosDevice: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "ios-1" };

  const runWithoutObservation = (selectAllText: SelectAllText) => {
    const observedSpy = spyOn(
      selectAllText as unknown as { observedInteraction: (fn: () => Promise<unknown>) => Promise<unknown> },
      "observedInteraction"
    ).mockImplementation(async (fn: () => Promise<unknown>) => fn());
    return { promise: selectAllText.execute(), observedSpy };
  };

  test("reports success when the Android accessibility service selects all", async () => {
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestSelectAll: async () => ({ success: true, totalTimeMs: 3 })
    } as unknown as AndroidCtrlProxyClient);

    const selectAllText = new SelectAllText(androidDevice, new FakeAdbClientFactory());
    const { promise, observedSpy } = runWithoutObservation(selectAllText);
    const result = await promise;

    expect(result).toEqual({ success: true });
    observedSpy.mockRestore();
  });

  test("labels the Android accessibility failure with the underlying error", async () => {
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestSelectAll: async () => ({ success: false, totalTimeMs: 3, error: "no focused field" })
    } as unknown as AndroidCtrlProxyClient);

    const selectAllText = new SelectAllText(androidDevice, new FakeAdbClientFactory());
    const { promise, observedSpy } = runWithoutObservation(selectAllText);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Accessibility service selectAll failed: no focused field");
    observedSpy.mockRestore();
  });

  test("reports success on the iOS CtrlProxy path", async () => {
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestSelectAll: async () => ({ success: true, totalTimeMs: 3 })
    } as unknown as IOSCtrlProxyClient);

    const selectAllText = new SelectAllText(iosDevice, new FakeAdbClientFactory());
    const { promise, observedSpy } = runWithoutObservation(selectAllText);
    const result = await promise;

    expect(result).toEqual({ success: true });
    observedSpy.mockRestore();
  });

  test("surfaces the iOS CtrlProxy failure error verbatim", async () => {
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestSelectAll: async () => ({ success: false, totalTimeMs: 3, error: "editor not first responder" })
    } as unknown as IOSCtrlProxyClient);

    const selectAllText = new SelectAllText(iosDevice, new FakeAdbClientFactory());
    const { promise, observedSpy } = runWithoutObservation(selectAllText);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBe("editor not first responder");
    observedSpy.mockRestore();
  });

  test("returns a structured failure when the iOS CtrlProxy throws", async () => {
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestSelectAll: async () => {
        throw new Error("socket closed");
      }
    } as unknown as IOSCtrlProxyClient);

    const selectAllText = new SelectAllText(iosDevice, new FakeAdbClientFactory());
    const { promise, observedSpy } = runWithoutObservation(selectAllText);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain("socket closed");
    observedSpy.mockRestore();
  });
});
