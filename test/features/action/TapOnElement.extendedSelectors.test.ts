import { describe, expect, test, spyOn } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { Element, ViewHierarchyResult } from "../../../src/models";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { logger } from "../../../src/utils/logger";
import { notificationHierarchy, notificationRows } from "../talkback/capturedNotificationTargets";

const createTapOnElement = (selector: FakeElementSelector) => {
  return new TapOnElement(
    {
      name: "test-device",
      platform: "android",
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    {
      timer: new FakeTimer(),
      elementSelector: selector,
    },
  );
};

const createDefaultTapOnElement = () => {
  return new TapOnElement(
    {
      name: "test-device",
      platform: "android",
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    {
      timer: new FakeTimer(),
    },
  );
};

const longClickResult = (success: boolean, error?: string) => ({
  success,
  action: "long_click",
  totalTimeMs: 1,
  error,
});

const makeElement = (bounds = { left: 0, top: 0, right: 100, bottom: 50 }) =>
  ({
    bounds,
    text: "Item",
    clickable: "true",
  }) as any;

describe("TapOnElement extended selectors", () => {
  test("budgets both Android long-press swipe forms from the requested duration", async () => {
    const tapOn = createDefaultTapOnElement();
    const adb = (tapOn as any).adb as FakeAdbClient;
    adb.setCommandError(
      "shell input touchscreen swipe 50 25 50 25 20000",
      new Error("touchscreen input unavailable"),
    );

    await (tapOn as any).executeAndroidLongPress(50, 25, 20_000, makeElement(), undefined, true);

    expect(
      adb
        .getCommandCalls()
        .filter((call) => call.command.includes("swipe"))
        .map((call) => call.timeoutMs),
    ).toEqual([22_000, 22_000]);
  });

  describe("validation", () => {
    test("rejects when no selector provided", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({ action: "tap" });
      expect(error).toContain("requires exactly one");
    });

    test("rejects when both selectors provided", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        text: "Login",
        elementId: "com.app:id/btn",
      });
      expect(error).toContain("requires exactly one");
    });

    test("accepts text as sole selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        text: "Login",
      });
      expect(error).toBeNull();
    });

    test("accepts elementId as sole selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        elementId: "com.app:id/btn",
      });
      expect(error).toBeNull();
    });

    test("accepts testTag as sole selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        testTag: "message_row_42",
      });
      expect(error).toBeNull();
    });

    test("accepts textAny as sole selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        textAny: ["Done", "Add"],
      });
      expect(error).toBeNull();
    });

    test("rejects empty textAny selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        textAny: [],
      });
      expect(error).toContain("non-empty");
    });

    test("accepts text with sibling flag", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        text: "Accept Terms",
        sibling: true,
      });
      expect(error).toBeNull();
    });

    test("accepts elementId with sibling flag", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        elementId: "com.app:id/label",
        sibling: true,
      });
      expect(error).toBeNull();
    });
  });

  describe("findElementInHierarchy", () => {
    test("delegates text to selectByText", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { text: "Login", action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastText).toBe("Login");
    });

    test("delegates elementId to selectByResourceId", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { elementId: "com.app:id/btn", action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastResourceId).toBe("com.app:id/btn");
    });

    test("delegates testTag to selectByTestTag", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { testTag: "message_row_42", action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastTestTag).toBe("message_row_42");
    });

    test("text + sibling delegates to selectClickableSiblingOfText", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { text: "Accept Terms", sibling: true, action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastText).toBe("Accept Terms");
    });

    test("elementId + sibling delegates to selectClickableSiblingOfResourceId", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { elementId: "com.app:id/label", sibling: true, action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastResourceId).toBe("com.app:id/label");
    });

    test("textAny tries variants in order and returns the first match", () => {
      class VariantSelector extends FakeElementSelector {
        override selectByText(...args: Parameters<FakeElementSelector["selectByText"]>) {
          this.setNextElement(args[1] === "Add" ? makeElement() : null);
          return super.selectByText(...args);
        }
      }
      const selector = new VariantSelector(null);
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { textAny: ["Done", "Add"], action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.textCalls).toEqual(["Done", "Add"]);
      expect(selector.lastText).toBe("Add");
    });

    test("textAny skips off-screen earlier variants when a later variant is visible", () => {
      const offScreenElement = makeElement({ left: -300, top: 0, right: -200, bottom: 50 });
      const visibleElement = makeElement({ left: 20, top: 20, right: 120, bottom: 70 });
      class VariantSelector extends FakeElementSelector {
        override selectByText(...args: Parameters<FakeElementSelector["selectByText"]>) {
          this.setNextElement(args[1] === "Done" ? offScreenElement : visibleElement);
          return super.selectByText(...args);
        }
      }
      const selector = new VariantSelector(null);
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { textAny: ["Done", "Add"], action: "tap" },
        { hierarchy: { node: {} }, screenWidth: 200, screenHeight: 200 },
      );

      expect(result.selection.element).toBe(visibleElement);
      expect(selector.textCalls).toEqual(["Done", "Add"]);
      expect(selector.lastText).toBe("Add");
    });

    test("textAny returns no element when every matched variant is off-screen", () => {
      const doneElement = makeElement({ left: -300, top: 0, right: -200, bottom: 50 });
      const addElement = makeElement({ left: 220, top: 20, right: 320, bottom: 70 });
      class VariantSelector extends FakeElementSelector {
        override selectByText(...args: Parameters<FakeElementSelector["selectByText"]>) {
          this.setNextElement(args[1] === "Done" ? doneElement : addElement);
          return super.selectByText(...args);
        }
      }
      const selector = new VariantSelector(null);
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { textAny: ["Done", "Add"], action: "tap" },
        { hierarchy: { node: {} }, screenWidth: 200, screenHeight: 200 },
      );

      expect(result.selection.element).toBeNull();
      expect(selector.textCalls).toEqual(["Done", "Add"]);
      expect(selector.lastText).toBe("Add");
    });

    test("textAny skips off-screen duplicate text matches before trying later variants", () => {
      const tapOn = createDefaultTapOnElement();

      const result = (tapOn as any).findElementInHierarchy(
        { textAny: ["Done", "Add"], action: "tap" },
        {
          hierarchy: {
            node: {
              $: { bounds: { left: 0, top: 0, right: 200, bottom: 200 } },
              node: [
                {
                  $: {
                    clickable: true,
                    text: "Done",
                    bounds: { left: -300, top: 0, right: -200, bottom: 50 },
                  },
                },
                {
                  $: {
                    clickable: true,
                    text: "Done",
                    bounds: { left: 20, top: 20, right: 120, bottom: 70 },
                  },
                },
                {
                  $: {
                    clickable: true,
                    text: "Add",
                    bounds: { left: 20, top: 90, right: 120, bottom: 140 },
                  },
                },
              ],
            },
          },
          screenWidth: 200,
          screenHeight: 200,
        },
      );

      expect(result.selection.element?.text).toBe("Done");
      expect(result.selection.element?.bounds).toEqual({
        left: 20,
        top: 20,
        right: 120,
        bottom: 70,
      });
    });

    test("sibling respects selectionStrategy", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      (tapOn as any).findElementInHierarchy(
        { text: "Email", sibling: true, action: "tap", selectionStrategy: "random" },
        { hierarchy: { node: {} } },
      );

      expect(selector.lastStrategy).toBe("random");
    });
  });

  describe("Android long press node selectors", () => {
    const testTagElement: Element = {
      ...makeElement(),
      "test-tag": "message_row_42",
      actions: ["long_click"],
    };

    function setup() {
      const proxy = new FakeCtrlProxy();
      proxy.setHierarchyData({ updatedAt: 1, packageName: "com.android.systemui", hierarchy: {} });
      proxy.setViewHierarchyResult(notificationHierarchy);
      const clientSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        proxy as unknown as AndroidCtrlProxyClient,
      );
      let tapOn: TapOnElement;
      try {
        tapOn = createDefaultTapOnElement();
      } finally {
        clientSpy.mockRestore();
      }
      const internals = tapOn as unknown as {
        adb: FakeAdbClient;
        executeAndroidLongPress(
          x: number,
          y: number,
          duration: number,
          element: Element,
        ): Promise<void>;
      };
      return { proxy, internals };
    }

    const uniqueIdElement: Element = {
      ...makeElement(),
      "resource-id": "com.android.systemui:id/notification_stack_scroller",
      actions: ["long_click"],
    };
    const repeatedIdElement: Element = { ...notificationRows[1], actions: ["long_click"] };
    const coordinateCommand = "shell input touchscreen swipe 50 25 50 25 1000";

    function expectCoordinateFallback({ proxy, internals }: ReturnType<typeof setup>) {
      expect(proxy.getActionHistory()).toEqual([]);
      expect(proxy.getNodeActionHistory()).toEqual([]);
      expect(internals.adb.getAllCommands()).toEqual([coordinateCommand]);
    }

    test("uses one bare-id long click after reading a complete unfiltered unique-id hierarchy", async () => {
      const { proxy, internals } = setup();
      const read = spyOn(proxy, "getAccessibilityHierarchy");
      try {
        await internals.executeAndroidLongPress(50, 25, 1000, uniqueIdElement);
        expect(read).toHaveBeenCalledWith(undefined, undefined, false, undefined, true);
        expect(proxy.getActionHistory()).toEqual([
          { action: "long_click", resourceId: uniqueIdElement["resource-id"], timeoutMs: 5000 },
        ]);
        expect(proxy.getNodeActionHistory()).toEqual([]);
        expect(internals.adb.getAllCommands()).toEqual([]);
      } finally {
        read.mockRestore();
      }
    });

    test("uses a stable test-tag selector for a repeated resource id", async () => {
      const { proxy, internals } = setup();
      await internals.executeAndroidLongPress(50, 25, 1000, {
        ...repeatedIdElement,
        "test-tag": "message_row_42",
      });
      expect(proxy.getNodeActionHistory()).toMatchObject([
        {
          action: "long_click",
          selector: { resourceId: repeatedIdElement["resource-id"], testTag: "message_row_42" },
        },
      ]);
      expect(proxy.getActionHistory()).toEqual([]);
      expect(proxy.getHierarchyRequestCount()).toBe(0);
      expect(internals.adb.getAllCommands()).toEqual([]);
    });

    test("uses coordinates for a repeated resource id without a stable node selector", async () => {
      const harness = setup();
      await harness.internals.executeAndroidLongPress(50, 25, 1000, repeatedIdElement);
      expectCoordinateFallback(harness);
    });

    test.each([
      ["null", null],
      ["error", { ...notificationHierarchy, hierarchy: { error: "capture failed" } }],
      ["incomplete", { ...notificationHierarchy, ctrlProxyIncomplete: true }],
      ["truncated", { ...notificationHierarchy, truncationReasons: ["max_children"] }],
      [
        "window truncated",
        { ...notificationHierarchy, windows: [{ id: 1, truncationReasons: ["max_children"] }] },
      ],
    ] satisfies [string, ViewHierarchyResult | null][])(
      "uses coordinates for an unverifiable resource id (%s hierarchy)",
      async (_name, hierarchy) => {
        const harness = setup();
        harness.proxy.setViewHierarchyResult(hierarchy);
        if (!hierarchy) {
          harness.proxy.setHierarchyData(null);
        }
        await harness.internals.executeAndroidLongPress(50, 25, 1000, uniqueIdElement);
        expectCoordinateFallback(harness);
      },
    );

    test("uses coordinates when the hierarchy reader throws", async () => {
      const harness = setup();
      harness.proxy.setFailureMode("getHierarchy", new Error("capture unavailable"));
      await harness.internals.executeAndroidLongPress(50, 25, 1000, uniqueIdElement);
      expectCoordinateFallback(harness);
    });

    test("uses coordinates when the resource id is absent from the hierarchy", async () => {
      const harness = setup();
      await harness.internals.executeAndroidLongPress(50, 25, 1000, {
        ...uniqueIdElement,
        "resource-id": "com.android.systemui:id/absent_row",
      });
      expectCoordinateFallback(harness);
    });

    test("propagates a stale display from the hierarchy reader without dispatching", async () => {
      const { proxy, internals } = setup();
      const stale = new StaleDisplayError({
        observedGeneration: 1,
        currentGeneration: 2,
        retry: "observe",
      });
      proxy.setFailureMode("getHierarchy", stale);
      await expect(internals.executeAndroidLongPress(50, 25, 1000, uniqueIdElement)).rejects.toBe(
        stale,
      );
      expect(proxy.getActionHistory()).toEqual([]);
      expect(proxy.getNodeActionHistory()).toEqual([]);
      expect(internals.adb.getAllCommands()).toEqual([]);
    });

    test("does not fall back after an advertised unique-id long click fails", async () => {
      const { proxy, internals } = setup();
      proxy.setActionResult(longClickResult(false, "service unavailable"));
      await expect(
        internals.executeAndroidLongPress(50, 25, 1000, uniqueIdElement),
      ).rejects.toThrow("Semantic long press failed for the selected element: service unavailable");
      expect(proxy.getActionHistory()).toHaveLength(1);
      expect(proxy.getNodeActionHistory()).toEqual([]);
      expect(internals.adb.getAllCommands()).toEqual([]);
    });

    test("logs a thrown bare-id action and falls back", async () => {
      const { proxy, internals } = setup();
      proxy.setFailureMode("requestAction", new Error("runner disconnected"));
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await internals.executeAndroidLongPress(50, 25, 1000, uniqueIdElement);
        expect(warning).toHaveBeenCalledWith(
          "[TapOnElement] Accessibility long click error: Error: runner disconnected",
        );
        expect(internals.adb.getAllCommands()).toEqual([coordinateCommand]);
      } finally {
        warning.mockRestore();
      }
    });

    test("uses ACTION_LONG_CLICK with a stable test-tag selector", async () => {
      const { proxy, internals } = setup();
      await internals.executeAndroidLongPress(50, 25, 1000, testTagElement);
      expect(proxy.getNodeActionHistory()).toMatchObject([
        { action: "long_click", selector: { testTag: "message_row_42" } },
      ]);
      expect(internals.adb.getAllCommands()).toEqual([]);
    });

    test("falls back to coordinates when a legacy runner lacks node selector support", async () => {
      const { proxy, internals } = setup();
      proxy.setSupportsNodeActionSelectors(false);
      const support = spyOn(proxy, "supportsNodeActionSelectors");
      const info = spyOn(logger, "info").mockImplementation(() => {});
      try {
        await internals.executeAndroidLongPress(50, 25, 1000, testTagElement);
        expect(support).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledWith(
          "[TapOnElement] Runner does not support stable node selectors; using coordinate long press",
        );
        expectCoordinateFallback({ proxy, internals });
      } finally {
        support.mockRestore();
        info.mockRestore();
      }
    });

    test("does not fall back after an advertised semantic long click fails", async () => {
      const { proxy, internals } = setup();
      proxy.setActionResult(longClickResult(false, "service unavailable"));
      await expect(internals.executeAndroidLongPress(50, 25, 1000, testTagElement)).rejects.toThrow(
        "Semantic long press failed for the selected element: service unavailable",
      );
      expect(proxy.getNodeActionHistory()).toHaveLength(1);
      expect(internals.adb.getAllCommands()).toEqual([]);
    });

    test("falls back after a failed unadvertised semantic long click", async () => {
      const { proxy, internals } = setup();
      proxy.setActionResult(longClickResult(false, "not supported"));
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await internals.executeAndroidLongPress(50, 25, 1000, { ...testTagElement, actions: [] });
        expect(warning).toHaveBeenCalledWith(
          "[TapOnElement] Accessibility long click failed: not supported",
        );
        expect(proxy.getNodeActionHistory()).toHaveLength(1);
        expect(internals.adb.getAllCommands()).toEqual([
          "shell input touchscreen swipe 50 25 50 25 1000",
        ]);
      } finally {
        warning.mockRestore();
      }
    });

    test.each([false, true])(
      "logs a thrown node action and falls back (advertised=%s)",
      async (advertised) => {
        const { proxy, internals } = setup();
        proxy.setFailureMode("requestNodeAction", new Error("runner disconnected"));
        const warning = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          await internals.executeAndroidLongPress(50, 25, 1000, {
            ...testTagElement,
            actions: advertised ? ["long_click"] : [],
          });
          expect(warning).toHaveBeenCalledWith(
            "[TapOnElement] Accessibility long click error: Error: runner disconnected",
          );
          expect(internals.adb.getAllCommands()).toEqual([
            "shell input touchscreen swipe 50 25 50 25 1000",
          ]);
        } finally {
          warning.mockRestore();
        }
      },
    );
  });
});
