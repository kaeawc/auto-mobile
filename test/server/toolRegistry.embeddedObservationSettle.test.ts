import { describe, expect, test } from "bun:test";
import { DefaultAfterToolCallHandler } from "../../src/server/toolRegistry";
import { RealSettleObserve } from "../../src/features/observe/SettleObserve";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import type { BootedDevice } from "../../src/models";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Wiring coverage for the #6866 settle gate inside the after-tool-call
 * pipeline: the finalized response a client receives must carry the settled
 * observation and its `settled` verdict. No daemon session is initialized, so
 * the baseline/diff branches stay off and the full observation is emitted.
 */

const device: BootedDevice = {
  name: "Pixel",
  deviceId: "emulator-5554",
  platform: "android",
};

function obs(text: string, updatedAt: number): ObserveResult {
  return {
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: {
      appId: "com.android.settings",
      activityName: ".SubSettings",
      layoutSeqSum: 1,
    },
    viewHierarchy: {
      packageName: "com.android.settings",
      hierarchy: {
        node: {
          class: "android.widget.TextView",
          "resource-id": "android:id/title",
          text,
        } as any,
      },
      updatedAt,
    },
  } as ObserveResult;
}

function handlerWith(fake: FakeObserveScreen): DefaultAfterToolCallHandler {
  return new DefaultAfterToolCallHandler(
    undefined,
    (_device, timer) => new RealSettleObserve(fake, timer),
  );
}

async function runAfterToolCall(
  handler: DefaultAfterToolCallHandler,
  name: string,
  response: unknown,
  timer: FakeTimer,
) {
  return handler.handle({
    name,
    args: {},
    device,
    internalCall: false,
    response,
    sessionUuid: undefined,
    shouldResolveDevice: false,
    timer,
    toolStartMs: 0,
  } as any);
}

describe("DefaultAfterToolCallHandler embedded-observation settle (#6866)", () => {
  test("tapOn's finalized observation is the settled capture, flagged settled:true", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs("Airplane mode", 20), obs("Airplane mode", 30)]);

    const response = createStructuredToolResponse({
      success: true,
      action: "tap",
      observation: obs("loading", 10),
    });

    const result = await runAfterToolCall(handlerWith(fake), "tapOn", response, timer);
    const payload = JSON.parse(result.finalizedResponse.content[0].text);

    expect(payload.observation.settled).toBe(true);
    expect(fake.getExecuteCallCount()).toBeGreaterThan(0);
  });

  test("an in-place action is not re-observed and reports settled:false", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs("Airplane mode", 20));

    const response = createStructuredToolResponse({
      success: true,
      observation: obs("Airplane mode", 10),
    });

    const result = await runAfterToolCall(handlerWith(fake), "clearText", response, timer);
    const payload = JSON.parse(result.finalizedResponse.content[0].text);

    expect(payload.observation.settled).toBe(false);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("a failed action's observation is stamped settled:false without re-observing", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs("Airplane mode", 20));

    const response = createStructuredToolResponse({
      success: false,
      error: "command failed",
      observation: obs("Airplane mode", 10),
    });

    const result = await runAfterToolCall(handlerWith(fake), "tapOn", response, timer);
    const payload = JSON.parse(result.finalizedResponse.content[0].text);

    expect(payload.observation.settled).toBe(false);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("the `observe` tool owns its own settle and is never re-observed here", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs("Airplane mode", 20));

    const response = createStructuredToolResponse(obs("Airplane mode", 10));
    await runAfterToolCall(handlerWith(fake), "observe", response, timer);

    expect(fake.getExecuteCallCount()).toBe(0);
  });
});
