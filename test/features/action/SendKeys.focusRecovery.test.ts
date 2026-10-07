import { describe, expect, spyOn, test } from "bun:test";
import { SendKeys, type SendKeysCommand } from "../../../src/features/action/SendKeys";
import { TapOnElement, tapFocusFailure } from "../../../src/features/action/TapOnElement";
import { Keyboard } from "../../../src/features/action/Keyboard";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { KeyboardOcclusionError } from "../../../src/models/KeyboardOcclusionError";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, ios, createSendKeysFocusHarness } from "./SendKeysTestHarness";

const commands: SendKeysCommand[] = [{ action: "type", text: "555", mode: "a11y" }];
const selector = { text: "Phone" };
const missing = {
  success: false,
  error: "Failed to perform tap on element: Element not found with provided text 'Phone'",
  [tapFocusFailure]: "not-found" as const,
};
const hint =
  "The field may be scrolled out of view; use swipeOn with lookFor to bring it into view, then retry.";
const occlusion = new KeyboardOcclusionError(
  'Target "Phone" is covered by the soft keyboard; dismiss the keyboard first.',
);

function tapResult(success: boolean, focusVerified?: boolean) {
  return {
    success,
    action: "focus",
    element: { bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
    focusVerified,
  };
}

describe("sendKeys selector focus recovery", () => {
  test("not-found selector makes no swipe or extra device command and appends only the hint", async () => {
    const h = createSendKeysFocusHarness();
    const swipe = spyOn(SwipeOn.prototype, "execute").mockResolvedValue({ success: true });
    try {
      h.replies.push(missing);
      const result = await h.action.execute(commands, selector);
      expect(h.calls).toEqual(["focus"]);
      expect(swipe).not.toHaveBeenCalled();
      expect(h.adb.getExecutedCommands()).toEqual([]);
      expect(result).toMatchObject({
        success: false,
        commands: [],
        completedCommands: 0,
        failedIndex: 0,
      });
      expect(result.error).toBe(`${missing.error} ${hint}`);
    } finally {
      swipe.mockRestore();
    }
  });

  test("stale s2 id does not scroll and gets the typed not-found hint", async () => {
    const h = createSendKeysFocusHarness();
    const swipe = spyOn(SwipeOn.prototype, "execute").mockResolvedValue({ success: true });
    try {
      const error =
        "Failed to perform tap on element: Element id 's2-stale' is stale; re-observe and use the id from the new observation.";
      h.replies.push({ ...missing, error });
      expect((await h.action.execute(commands, { elementId: "s2-stale" })).error).toBe(
        `${error} ${hint}`,
      );
      expect(h.calls).toEqual(["focus"]);
      expect(swipe).not.toHaveBeenCalled();
      expect(h.adb.getExecutedCommands()).toEqual([]);
    } finally {
      swipe.mockRestore();
    }
  });

  for (const reason of ["no-visible-tap-area", "navigation-bar"] as const) {
    test(`${reason}: off-screen-but-present field gets the hint`, async () => {
      const h = createSendKeysFocusHarness();
      const error =
        reason === "navigation-bar"
          ? 'Target "Phone" is covered by the navigation bar; scroll it into view with swipeOn, then retry tapOn.'
          : 'Matched element "Phone" has no visible tap area (bounds {}). Scroll it into view with swipeOn, then retry tapOn.';
      h.replies.push({ success: false, error, [tapFocusFailure]: reason });
      expect((await h.action.execute(commands, selector)).error).toBe(`${error} ${hint}`);
      expect(h.calls).toEqual(["focus"]);
    });
  }

  for (const error of [
    "Target ambiguous: 2 matches",
    "Cannot focus Phone because it is not an editable input",
    "Selected display has no view hierarchy",
    "Container element not found with provided elementId 'form'",
    missing.error,
  ]) {
    test(`${error}: unmarked failure gets no hint`, async () => {
      const h = createSendKeysFocusHarness();
      h.replies.push({ success: false, error });
      expect((await h.action.execute(commands, selector)).error).toBe(error);
      expect(h.calls).toEqual(["focus"]);
    });
  }

  test("Android occlusion closes once, refreshes, re-resolves in scope and requires verified focus", async () => {
    const h = createSendKeysFocusHarness();
    const scope = { container: { elementId: "form" }, selectionStrategy: "unique" as const };
    h.replies.push(occlusion, { success: true, focusVerified: true });
    expect(
      (await h.action.execute(commands, selector, undefined, undefined, undefined, scope)).success,
    ).toBe(true);
    expect(h.calls).toEqual(["focus", "close", "refresh", "focus", "type"]);
    expect(h.focusCalls).toHaveLength(2);
    expect(h.focusCalls[1]).toEqual(h.focusCalls[0]);
    expect(h.focusCalls[1].options).toEqual(scope);
  });

  for (const focusVerified of [undefined, false]) {
    test(`retry focusVerified=${focusVerified}: refuses typing after an unverified retry`, async () => {
      const h = createSendKeysFocusHarness();
      h.replies.push(occlusion, { success: true, focusVerified });
      expect(await h.action.execute(commands, selector)).toMatchObject({
        success: false,
        error: "Failed to confirm focus on target field after closing the keyboard",
        commands: [],
      });
      expect(h.calls).toEqual(["focus", "close", "refresh", "focus"]);
    });
  }

  for (const throws of [false, true]) {
    test(`retry ${throws ? "throws" : "returns"} a different failure: surfaces that reason`, async () => {
      const h = createSendKeysFocusHarness();
      const error = "Cannot focus Phone because it is not an editable input";
      h.replies.push(occlusion, throws ? new Error(error) : { success: false, error });
      expect(await h.action.execute(commands, selector)).toMatchObject({
        success: false,
        error,
        commands: [],
      });
      expect(h.calls).toEqual(["focus", "close", "refresh", "focus"]);
    });
  }

  test("keyboard retry not-found surfaces the new error plus hint", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(occlusion, missing);
    expect((await h.action.execute(commands, selector)).error).toBe(`${missing.error} ${hint}`);
    expect(h.calls).toEqual(["focus", "close", "refresh", "focus"]);
  });

  test("failed close preserves the occlusion and makes no retry", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(occlusion);
    h.recovery.close = async () => ({ success: false });
    expect((await h.action.execute(commands, selector)).error).toBe(occlusion.message);
    expect(h.calls).toEqual(["focus", "close"]);
  });

  test("throwing close preserves the occlusion and makes no retry", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(occlusion);
    h.recovery.close = async () => {
      throw new Error("keyboard transport failed");
    };
    expect((await h.action.execute(commands, selector)).error).toBe(occlusion.message);
    expect(h.calls).toEqual(["focus", "close"]);
  });

  test("iOS keyboard refusal does not close the keyboard", async () => {
    const h = createSendKeysFocusHarness(ios);
    h.replies.push({ success: false, error: occlusion.message });
    expect((await h.action.execute(commands, selector)).error).toBe(occlusion.message);
    expect(h.calls).toEqual(["focus"]);
  });

  test("repeated occlusion terminates after one keyboard close", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(occlusion, occlusion);
    expect((await h.action.execute(commands, selector)).error).toBe(occlusion.message);
    expect(h.calls).toEqual(["focus", "close", "refresh", "focus"]);
  });

  test("display-routed occlusion skips the unrouteable keyboard close", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(occlusion);
    expect((await h.action.execute(commands, selector, undefined, undefined, "0")).error).toBe(
      occlusion.message,
    );
    expect(h.calls).toEqual(["focus"]);
  });

  test("display-routed not-found retains the original error plus hint without recovery", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(missing);
    expect((await h.action.execute(commands, selector, undefined, undefined, "0")).error).toBe(
      `${missing.error} ${hint}`,
    );
    expect(h.calls).toEqual(["focus"]);
  });

  test("abort during keyboard close propagates without retry", async () => {
    const h = createSendKeysFocusHarness();
    const controller = new AbortController();
    const reason = new Error("cancel close");
    h.replies.push(occlusion);
    h.recovery.close = async () => {
      controller.abort(reason);
      return { success: true };
    };
    await expect(h.action.execute(commands, selector, undefined, controller.signal)).rejects.toBe(
      reason,
    );
    expect(h.calls).toEqual(["focus", "close"]);
    expect(h.signals).toEqual([controller.signal]);
  });

  test("displayRoutingFailure propagates abort during focus", async () => {
    const h = createSendKeysFocusHarness();
    const controller = new AbortController();
    const reason = new Error("cancel routed focus");
    const action = new SendKeys(android, new FakeAdbClientFactory(h.adb), {
      timer: new FakeTimer(),
      executor: h.executor,
      observer: { execute: async () => h.observation },
      displayTransitions: h.transitions,
      lastRenderedObservation: () => h.observation,
      focuser: {
        focus: async () => {
          controller.abort(reason);
          throw reason;
        },
      },
    });
    await expect(
      action.execute(commands, selector, undefined, controller.signal, "0"),
    ).rejects.toBe(reason);
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  test("first focus success and selector-less input make zero recovery calls", async () => {
    const h = createSendKeysFocusHarness();
    expect((await h.action.execute(commands, selector)).success).toBe(true);
    expect(h.calls).toEqual(["focus", "type"]);
    expect(h.focusCalls).toHaveLength(1);
    h.calls.length = 0;
    expect((await h.action.execute(commands)).success).toBe(true);
    expect(h.calls).toEqual(["type"]);
  });

  test("iOS semantic-key focus failure gets the hint without scrolling", async () => {
    const h = createSendKeysFocusHarness(ios);
    h.replies.push(missing);
    expect((await h.action.execute([{ action: "key", key: "done" }], selector)).error).toBe(
      `${missing.error} ${hint}`,
    );
    expect(h.calls).toEqual(["focus"]);
    expect(h.clientCalls).toEqual([]);
  });

  for (const display of [undefined, "0"]) {
    test(`${display ?? "default"}: default focuser preserves typed focus evidence and keyboard opt-in`, async () => {
      const h = createSendKeysFocusHarness();
      const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({
        ...tapResult(false),
        ...missing,
      });
      try {
        const action = new SendKeys(android, new FakeAdbClientFactory(h.adb), {
          timer: new FakeTimer(),
          executor: h.executor,
          observer: { execute: async () => h.observation },
          displayTransitions: h.transitions,
          lastRenderedObservation: () => h.observation,
        });
        expect(
          (await action.execute(commands, selector, undefined, undefined, display)).error,
        ).toBe(`${missing.error} ${hint}`);
        expect(tap.mock.calls[0][3]).toEqual({ throwOnKeyboardOcclusion: true });
        expect(tap).toHaveBeenCalledTimes(1);
      } finally {
        tap.mockRestore();
      }
    });
  }

  test("default recovery uses injected adbFactory/timer and carries verified focus from TapOnElement", async () => {
    const h = createSendKeysFocusHarness();
    const factory = new FakeAdbClientFactory(h.adb);
    const timer = new FakeTimer();
    const tap = spyOn(TapOnElement.prototype, "execute")
      .mockRejectedValueOnce(occlusion)
      .mockResolvedValue(tapResult(true, true));
    const close = spyOn(Keyboard.prototype, "execute").mockImplementation(async function (
      this: Keyboard,
    ) {
      expect(Reflect.get(this, "timer")).toBe(timer);
      expect(Reflect.get(this, "adb")).toBe(h.adb);
      return { success: true, action: "close", keyboardOpen: false };
    });
    const freshReads: Array<
      Parameters<
        NonNullable<
          import("../../../src/features/action/SendKeys").SendKeysDependencies["observer"]
        >["execute"]
      >[0]
    > = [];
    try {
      const action = new SendKeys(android, factory, {
        timer,
        executor: h.executor,
        observer: {
          execute: async (options) => {
            freshReads.push(options);
            return h.observation;
          },
        },
        displayTransitions: h.transitions,
        lastRenderedObservation: () => h.observation,
      });
      expect((await action.execute(commands, selector)).success).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      expect(tap).toHaveBeenCalledTimes(2);
      expect(tap.mock.calls[1][0]).toEqual({ ...selector, action: "focus", display: undefined });
      expect(freshReads).toContainEqual({
        signal: undefined,
        freshness: "fresh",
        minTimestamp: 0,
        skipScreenshot: true,
      });
      expect(factory.getCallCount()).toBe(4);
    } finally {
      tap.mockRestore();
      close.mockRestore();
    }
  });
});
