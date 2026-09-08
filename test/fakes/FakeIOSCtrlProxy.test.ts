import { describe, expect, test } from "bun:test";
import { FakeIOSCtrlProxy } from "./FakeIOSCtrlProxy";
import { FakeTimer } from "./FakeTimer";

describe("FakeIOSCtrlProxy operation delays", () => {
  test("pressKey waits for the injected virtual clock before recording success", async () => {
    const timer = new FakeTimer();
    const proxy = new FakeIOSCtrlProxy(timer);
    proxy.setOperationDelay("pressKey", 500);
    let settled = false;
    const result = proxy.requestPressKey("tab", []).then((value) => {
      settled = true;
      return value;
    });

    expect(timer.getSleepHistory()).toEqual([500]);
    timer.advanceTime(499);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(proxy.getPressKeyHistory()).toEqual([]);
    timer.advanceTime(1);
    expect((await result).success).toBe(true);
    expect(proxy.getPressKeyHistory()).toEqual([{ key: "tab", modifiers: [] }]);
  });

  test("other operations use the same injected clock", async () => {
    const timer = new FakeTimer();
    const proxy = new FakeIOSCtrlProxy(timer);
    proxy.setOperationDelay("pressHome", 250);
    const result = proxy.requestPressHome();
    expect(timer.getSleepHistory()).toEqual([250]);
    timer.advanceTime(250);
    expect((await result).success).toBe(true);
    expect(proxy.getPressHomeRequestCount()).toBe(1);
  });

  test("zero delays and the no-argument constructor remain compatible", async () => {
    const timer = new FakeTimer();
    const proxy = new FakeIOSCtrlProxy(timer);
    expect((await proxy.requestPressKey("tab", [])).success).toBe(true);
    expect(timer.getSleepHistory()).toEqual([]);
    expect((await new FakeIOSCtrlProxy().requestPressHome()).success).toBe(true);
  });

  test("configured failures reject after virtual delay without recording success", async () => {
    const timer = new FakeTimer();
    const proxy = new FakeIOSCtrlProxy(timer);
    const failure = new Error("configured failure");
    proxy.setOperationDelay("pressKey", 500);
    proxy.setFailureMode("pressKey", failure);
    const result = proxy.requestPressKey("tab", []).catch((error: unknown) => error);
    expect(timer.getSleepHistory()).toEqual([500]);
    timer.advanceTime(500);
    expect(await result).toBe(failure);
    expect(proxy.getPressKeyHistory()).toEqual([]);
    proxy.setFailureMode("pressKey", null);
    proxy.setOperationDelay("pressKey", 0);
    expect((await proxy.requestPressKey("tab", [])).success).toBe(true);
  });
});
