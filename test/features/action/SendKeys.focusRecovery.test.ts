import { describe, expect, spyOn, test } from "bun:test";
import { SendKeys, type SendKeysCommand } from "../../../src/features/action/SendKeys";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { KeyboardOcclusionError } from "../../../src/models/KeyboardOcclusionError";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, ios, createSendKeysFocusHarness } from "./SendKeysTestHarness";

const commands: SendKeysCommand[] = [{ action: "type", text: "555", mode: "a11y" }];
const selector = { text: "Phone" };
const missing = {
  success: false,
  error: "Failed to perform tap on element: Element not found with provided text 'Phone'",
};
const occlusion = new KeyboardOcclusionError(
  'Target "Phone" is covered by the soft keyboard; dismiss the keyboard first.',
);

describe("sendKeys selector focus recovery", () => {
  for (const display of [undefined, "0"]) {
    test(`${display ?? "default"}: not-found scrolls once then focuses before typing`, async () => {
      const h = createSendKeysFocusHarness();
      h.replies.push(missing, { success: true });
      const scope = { container: { elementId: "form" }, selectionStrategy: "unique" as const };
      expect(
        (await h.action.execute(commands, selector, undefined, undefined, display, scope)).success,
      ).toBe(true);
      expect(h.calls).toEqual(["focus", "swipe", "focus", "type"]);
      expect(h.swipes).toEqual([
        {
          direction: "up",
          display,
          container: scope.container,
          lookFor: { text: "Phone", ...scope },
        },
      ]);
      expect(h.focusCalls).toHaveLength(2);
      expect(
        h.focusCalls.every(
          (call) => call.display === display && call.options?.container === scope.container,
        ),
      ).toBe(true);
    });

    test(`${display ?? "default"}: Android occlusion closes once and retries`, async () => {
      const h = createSendKeysFocusHarness();
      h.replies.push(occlusion, { success: true });
      expect(
        (await h.action.execute(commands, selector, undefined, undefined, display)).success,
      ).toBe(true);
      expect(h.calls).toEqual(["focus", "close", "focus", "type"]);
    });

    test(`${display ?? "default"}: abort during scroll propagates`, async () => {
      const h = createSendKeysFocusHarness();
      const controller = new AbortController();
      const reason = new Error("cancel scroll");
      h.replies.push(missing);
      h.recovery.swipe = async () => {
        controller.abort(reason);
        throw reason;
      };
      await expect(
        h.action.execute(commands, selector, undefined, controller.signal, display),
      ).rejects.toBe(reason);
      expect(h.calls).toEqual(["focus", "swipe"]);
      expect(h.signals).toEqual([controller.signal]);
    });
  }

  for (const failure of [
    "scroll-empty",
    "scroll-throws",
    "retry-missing",
    "retry-throws",
  ] as const) {
    test(`${failure}: preserves the original not-found with a manual scroll hint`, async () => {
      const h = createSendKeysFocusHarness();
      h.replies.push(missing, failure === "retry-throws" ? new Error("retry failed") : missing);
      if (failure === "scroll-empty") {
        h.recovery.swipe = async () => ({ success: false });
      }
      if (failure === "scroll-throws") {
        h.recovery.swipe = async () => {
          throw new Error("search failed");
        };
      }
      const result = await h.action.execute(commands, selector);
      expect(result).toMatchObject({
        success: false,
        failedIndex: 0,
        completedCommands: 0,
        commands: [],
      });
      expect(result.error).toStartWith(missing.error);
      expect(result.error).toContain("scrolled out of view");
      expect(result.error).toContain("swipeOn");
      expect(result.error).toContain("lookFor");
      expect(h.calls).toEqual(
        failure.startsWith("scroll") ? ["focus", "swipe"] : ["focus", "swipe", "focus"],
      );
    });
  }

  for (const failure of ["close-fails", "close-throws", "retry-fails", "retry-throws"] as const) {
    test(`${failure}: preserves original Android occlusion`, async () => {
      const h = createSendKeysFocusHarness();
      h.replies.push(occlusion, failure === "retry-throws" ? new Error("retry failed") : missing);
      if (failure === "close-fails") {
        h.recovery.close = async () => ({ success: false });
      }
      if (failure === "close-throws") {
        h.recovery.close = async () => {
          throw new Error("close failed");
        };
      }
      expect(await h.action.execute(commands, selector)).toMatchObject({
        success: false,
        error: occlusion.message,
        commands: [],
      });
      expect(h.calls).toEqual(
        failure.startsWith("close") ? ["focus", "close"] : ["focus", "close", "focus"],
      );
    });
  }

  test("scroll retry can recover from occlusion with one close and one further focus", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(missing, occlusion, { success: true });
    expect((await h.action.execute(commands, selector)).success).toBe(true);
    expect(h.calls).toEqual(["focus", "swipe", "focus", "close", "focus", "type"]);
  });

  test("failed keyboard recovery after scrolling preserves the occlusion refusal", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(missing, occlusion, occlusion);
    expect(await h.action.execute(commands, selector)).toMatchObject({
      success: false,
      error: occlusion.message,
      commands: [],
    });
    expect(h.calls).toEqual(["focus", "swipe", "focus", "close", "focus"]);
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

  test("first focus success and selector-less input make zero recovery calls", async () => {
    const h = createSendKeysFocusHarness();
    expect((await h.action.execute(commands, selector)).success).toBe(true);
    expect(h.calls).toEqual(["focus", "type"]);
    h.calls.length = 0;
    expect((await h.action.execute(commands)).success).toBe(true);
    expect(h.calls).toEqual(["type"]);
  });

  test("elementId lookFor is supported on iOS too", async () => {
    const h = createSendKeysFocusHarness(ios);
    h.replies.push({ ...missing, error: "Element not found with provided elementId 'phone'" });
    expect((await h.action.execute(commands, { elementId: "phone" })).success).toBe(true);
    expect(h.swipes[0].lookFor).toEqual({ elementId: "phone" });
    expect(h.calls).toEqual(["focus", "swipe", "focus", "type"]);
  });

  test("iOS keyboard refusal does not dismiss the keyboard", async () => {
    const h = createSendKeysFocusHarness(ios);
    h.replies.push({ success: false, error: occlusion.message });
    expect((await h.action.execute(commands, selector)).error).toBe(occlusion.message);
    expect(h.calls).toEqual(["focus"]);
  });

  test("unexpressible selectors and unrelated routing failures do not scroll", async () => {
    for (const target of [{ testTag: "phone" }, { text: "Phone" }]) {
      const h = createSendKeysFocusHarness();
      const error = target.testTag
        ? "Element not found with provided testTag 'phone'"
        : "Failed to perform tap on element: Container element not found with provided elementId 'form'";
      h.replies.push({ success: false, error });
      expect((await h.action.execute(commands, target)).error).toBe(error);
      expect(h.calls).toEqual(["focus"]);
    }
  });

  test("iOS bounded semantic-key route recovers the same selector focus", async () => {
    const h = createSendKeysFocusHarness(ios);
    h.replies.push(missing);
    expect((await h.action.execute([{ action: "key", key: "done" }], selector)).success).toBe(true);
    expect(h.calls).toEqual(["focus", "swipe", "focus"]);
    expect(h.clientCalls).toEqual(["ime"]);
  });

  test("display routing preserves the not-found hint when scroll finds nothing", async () => {
    const h = createSendKeysFocusHarness();
    h.replies.push(missing);
    h.recovery.swipe = async () => ({ success: false });
    const result = await h.action.execute(commands, selector, undefined, undefined, "0");
    expect(result.error).toStartWith(missing.error);
    expect(result.error).toContain("swipeOn with lookFor");
    expect(result.commands).toEqual([]);
    expect(h.calls).toEqual(["focus", "swipe"]);
  });

  for (const display of [undefined, "0"]) {
    test(`${display ?? "default"}: default focuser opts into the typed keyboard signal`, async () => {
      const h = createSendKeysFocusHarness();
      const tap = spyOn(TapOnElement.prototype, "execute").mockRejectedValue(occlusion);
      try {
        const action = new SendKeys(android, new FakeAdbClientFactory(h.adb), {
          timer: new FakeTimer(),
          executor: h.executor,
          observer: { execute: async () => h.observation },
          displayTransitions: h.transitions,
          lastRenderedObservation: () => h.observation,
          timestampProvider: { now: async () => 1 },
          keyboard: { execute: async () => ({ success: false }) },
        });
        expect(
          (await action.execute(commands, selector, undefined, undefined, display)).error,
        ).toBe(occlusion.message);
        expect(tap.mock.calls[0][3]).toEqual({ throwOnKeyboardOcclusion: true });
      } finally {
        tap.mockRestore();
      }
    });
  }
});
