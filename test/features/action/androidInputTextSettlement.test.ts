import { expect, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { DefaultSendKeysCommandExecutor } from "../../../src/features/action/SendKeys";
import {
  TextRequestState,
  runWithTextRequestContext,
} from "../../../src/features/action/textTransportTimeout";
import {
  buildAndroidInputTextCommand,
  type KeyEventPlan,
} from "../../../src/utils/android-cmdline-tools/asciiKeyEvents";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeGuestInputAdb } from "../../fakes/FakeGuestInputAdb";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
import { android, createSendKeysHarness, observer } from "./SendKeysTestHarness";

test.each(["InputText", "SendKeys eventAll", "SendKeys plan"] as const)(
  "%s holds dispatch/release and follow-up while guest outlives host cancellation",
  async (path) => {
    const adb = new FakeGuestInputAdb();
    adb.setAndroidApiLevel(34);
    const timer = new FakeTimer();
    const controller = new AbortController();
    const error = new Error("cancelled text");
    const state = new TextRequestState();
    const plan = { commands: [buildAndroidInputTextCommand("abcd")], textLength: 4 };
    adb.setTypingDuration(timer, 150);
    const input = new InputText(android, adb, undefined, timer);
    const executor = new DefaultSendKeysCommandExecutor(
      android,
      new FakeAdbClientFactory(adb),
      observer,
      {
        timer,
        textClient: createSendKeysHarness(android).client,
      },
    );
    // InputText currently produces single-character plans; exercise its text-plan
    // dispatch seam directly. SendKeys eventAll also exercises the public batched path.
    const inputPlan = input as unknown as {
      executeKeyEventPlan(
        plan: KeyEventPlan,
        timeout?: number,
        noRetry?: boolean,
        before?: undefined,
        signal?: AbortSignal,
      ): Promise<void>;
    };
    const sendPlan = executor as unknown as {
      executeKeyEventPlan(plan: KeyEventPlan, signal?: AbortSignal): Promise<void>;
    };
    const result = runWithTextRequestContext(
      { getDeadlineMs: () => undefined, textState: state },
      () =>
        path === "InputText"
          ? inputPlan.executeKeyEventPlan(plan, undefined, true, undefined, controller.signal)
          : path === "SendKeys plan"
            ? sendPlan.executeKeyEventPlan(plan, controller.signal)
            : executor.type({ action: "type", text: "abcd", mode: "eventAll" }, controller.signal),
    );
    let settled = false;
    const outcome = result.then(
      (value) => {
        settled = true;
        return value;
      },
      (failure: unknown) => {
        settled = true;
        return failure;
      },
    );
    await adb.entered.promise;
    if (path === "InputText") {
      expect(state.hasPending()).toBe(true);
    }
    controller.abort(error);
    adb.host.reject(error);
    let released = false;
    const followUp = (path === "InputText" ? state.settled() : outcome).then(async () => {
      released = true;
      await adb.execute(["shell", "input", "keyevent", "KEYCODE_ENTER"]);
    });
    await drainMicrotasks(100);
    expect(settled).toBe(false);
    expect(released).toBe(false);
    expect(adb.wasCommandExecuted("KEYCODE_ENTER")).toBe(false);
    expect(adb.cleanupCalls.length).toBeGreaterThan(0);
    expect(adb.cleanupCalls.every(({ args }) => !args[1].includes("kill "))).toBe(true);
    await drainUntil(() => timer.getPendingSleepCount() > 0, { description: "guest settlement" });
    expect(timer.getPendingTimeouts()).toContain(3016);
    timer.advanceTime(75);
    await drainMicrotasks(50);
    expect(released).toBe(false);
    timer.advanceTime(75);
    expect(await outcome).toBe(error);
    await followUp;
    expect(released).toBe(true);
    expect(state.hasPending()).toBe(false);
    expect(adb.wasCommandExecuted("KEYCODE_ENTER")).toBe(true);
    expect(adb.isTyping()).toBe(false);
    expect(adb.getApiLevelCalls()).toHaveLength(1);
    expect(adb.getExecutedCommands().some((command) => command.includes("getprop"))).toBe(false);
  },
);
