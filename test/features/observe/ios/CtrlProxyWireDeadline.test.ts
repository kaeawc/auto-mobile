import { describe, expect, test } from "bun:test";
import { sendCommand } from "../../../../src/features/observe/DeviceServiceUtils";
import { iosWireDeadlineParams } from "../../../../src/features/observe/ios/CtrlProxyDispatch";
import { CtrlProxyNavigation } from "../../../../src/features/observe/ios/CtrlProxyNavigation";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("iOS wire deadline (#10084)", () => {
  test.each([
    "request_tap_coordinates",
    "request_rotate",
    "request_press_button",
    "request_press_home",
    "request_set_text",
    "request_clipboard",
    "request_launch_app",
    "request_action",
    "request_keyboard",
    "set_hinge_angle",
    "set_preference",
    "remove_preference",
    "clear_preferences",
  ])("%s carries the host wait budget as an integer timeoutMs", (type) => {
    expect(iosWireDeadlineParams(type, 5000)).toEqual({ timeoutMs: 5000 });
    expect(iosWireDeadlineParams(type, 4321.6)).toEqual({ timeoutMs: 4322 });
  });

  test.each([
    "request_hierarchy",
    "request_screenshot",
    "request_swipe",
    "execute_sql",
    "get_preferences",
    "get_preference",
    "list_preference_files",
    "not_a_request",
  ])("%s does not get a generic deadline", (type) => {
    expect(iosWireDeadlineParams(type, 5000)).toEqual({});
  });

  test("a non-positive or non-finite budget is never sent", () => {
    expect(iosWireDeadlineParams("request_rotate", 0)).toEqual({});
    expect(iosWireDeadlineParams("request_rotate", -1)).toEqual({});
    expect(iosWireDeadlineParams("request_rotate", Number.NaN)).toEqual({});
  });

  test("a delegate command sends its timeout without the call site naming the field", async () => {
    const h = createIosDelegateHarness();
    h.context.wireDeadlineParams = iosWireDeadlineParams;
    const pending = new CtrlProxyNavigation(h.context).requestRotate("landscape", 4321.4);
    await flushMicrotasks();

    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]).toMatchObject({
      type: "request_rotate",
      orientation: "landscape",
      timeoutMs: 4321,
    });
    h.advanceTime(5000);
    expect((await pending).success).toBe(false);
  });

  test("a context without the hook keeps the legacy wire shape", async () => {
    const h = createIosDelegateHarness();
    const pending = new CtrlProxyNavigation(h.context).requestRotate("landscape", 4000);
    await flushMicrotasks();

    expect(h.sentMessages[0]).not.toHaveProperty("timeoutMs");
    h.advanceTime(5000);
    await pending;
  });

  test("an explicit timeoutMs param is not overridden and the hook sees the clamped budget", async () => {
    const h = createIosDelegateHarness();
    const seen: number[] = [];
    h.context.wireDeadlineParams = (_type, timeoutMs) => {
      seen.push(timeoutMs);
      return { timeoutMs };
    };
    const clamped = sendCommand(h.context, {
      idPrefix: "tap",
      responseType: "tap_result",
      messageType: "request_tap_coordinates",
      timeoutMs: 5000,
      deadlineMs: h.timer.now() + 1200,
    });
    const explicit = sendCommand(h.context, {
      idPrefix: "swipe",
      responseType: "swipe_result",
      messageType: "request_swipe",
      params: { timeoutMs: 99 },
      timeoutMs: 5000,
    });
    await flushMicrotasks();

    expect(seen).toEqual([1200, 5000]);
    expect(h.sentMessages[0].timeoutMs).toBe(1200);
    expect(h.sentMessages[1].timeoutMs).toBe(99);
    h.advanceTime(6000);
    await Promise.all([clamped, explicit]);
  });
});
