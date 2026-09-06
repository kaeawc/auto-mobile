import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";

// Regression coverage for #6248: the iOS branch of TapAnyElement previously called
// tap/doubleTap/longPress on IOSCtrlProxyClient, none of which exist (TS2339,
// tolerated in scripts/typecheck-baseline.txt) — every iOS tapAny action failed
// in ~5ms with "D.tap is not a function". The real gesture API is
// requestTapCoordinates, which TapOnElement already uses successfully.
describe("TapAnyElement iOS gesture dispatch", () => {
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
  });

  const createTapAny = (fakeIosClient: FakeIOSCtrlProxy) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    return new TapAnyElement(
      {
        name: "test-iphone",
        platform: "ios",
        id: "00001234-ABCD",
        deviceId: "00001234-ABCD",
      } as any,
      new FakeAdbClient() as any,
      {
        timer,
      },
    );
  };

  const wireCtrlProxy = async (fakeIosClient: FakeIOSCtrlProxy) => {
    const iosModule = await import("../../../src/features/observe/ios");
    getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIosClient as any,
    );
  };

  test("tap calls requestTapCoordinates once with the target coordinates", async () => {
    const fakeIosClient = new FakeIOSCtrlProxy();
    await wireCtrlProxy(fakeIosClient);
    const tapAny = createTapAny(fakeIosClient);

    await (tapAny as any).executeIosTap("tap", 42, 84, 0);

    expect(fakeIosClient.getTapHistory()).toEqual([{ x: 42, y: 84, duration: 50 }]);
    // Never call the non-existent methods from the original bug.
    expect((fakeIosClient as any).tap).toBeUndefined();
  });

  test("doubleTap calls requestTapCoordinates twice with the target coordinates", async () => {
    const fakeIosClient = new FakeIOSCtrlProxy();
    await wireCtrlProxy(fakeIosClient);
    const tapAny = createTapAny(fakeIosClient);

    await (tapAny as any).executeIosTap("doubleTap", 10, 20, 0);

    expect(fakeIosClient.getTapHistory()).toEqual([
      { x: 10, y: 20, duration: 50 },
      { x: 10, y: 20, duration: 50 },
    ]);
    expect((fakeIosClient as any).doubleTap).toBeUndefined();
  });

  test("longPress calls requestTapCoordinates once with the long-press duration", async () => {
    const fakeIosClient = new FakeIOSCtrlProxy();
    await wireCtrlProxy(fakeIosClient);
    const tapAny = createTapAny(fakeIosClient);

    await (tapAny as any).executeIosTap("longPress", 5, 6, 1500);

    expect(fakeIosClient.getTapHistory()).toEqual([{ x: 5, y: 6, duration: 1500 }]);
    expect((fakeIosClient as any).longPress).toBeUndefined();
  });

  test("tap throws an ActionableError when the proxy reports failure", async () => {
    const fakeIosClient = new FakeIOSCtrlProxy();
    fakeIosClient.setTapResult({ success: false, error: "boom", totalTimeMs: 1 });
    await wireCtrlProxy(fakeIosClient);
    const tapAny = createTapAny(fakeIosClient);

    await expect((tapAny as any).executeIosTap("tap", 1, 2, 0)).rejects.toThrow(
      "CtrlProxy iOS tap failed: boom",
    );
  });
});
