import { describe, expect, test } from "bun:test";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";

const createTapAnyElement = (selector: FakeElementSelector) => {
  return new TapAnyElement(
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

const makeElement = () =>
  ({
    bounds: { left: 10, top: 20, right: 110, bottom: 70 },
    text: "ListItem",
    clickable: "true",
  }) as any;

describe("TapAnyElement", () => {
  test("budgets an Android long press beyond the default ADB timeout", async () => {
    const adb = new FakeAdbClient();
    const tapAny = new TapAnyElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" },
      adb as any,
      { timer: new FakeTimer(), elementSelector: new FakeElementSelector(makeElement()) },
    );
    (tapAny as any).observedInteraction = (action: (result: any) => Promise<unknown>) =>
      action({
        viewHierarchy: { hierarchy: { node: {} } },
        screenSize: { width: 500, height: 500 },
      });

    await tapAny.execute({ action: "longPress", duration: 20_000 });
    const swipe = adb
      .getCommandCalls()
      .find((call) => call.command.startsWith("shell input swipe"));
    expect(swipe?.timeoutMs).toBe(22_000);
  });

  describe("validateOptions", () => {
    const EXACTLY_ONE = "container must specify exactly one";

    // A container must resolve to exactly one truthy selector. Zero truthy
    // selectors ({}, or both empty strings) is an error just like two — an empty
    // container cannot be located, so it must not pass validation and fall through
    // to an ambiguous match.
    test.each<[string, Record<string, unknown> | undefined, string | null]>([
      ["no container", undefined, null],
      ["elementId only", { elementId: "com.app:id/list" }, null],
      ["text only", { text: "My List" }, null],
      ["empty elementId but real text", { elementId: "", text: "List" }, null],
      ["real elementId but empty text", { elementId: "com.app:id/list", text: "" }, null],
      ["both elementId and text", { elementId: "com.app:id/list", text: "List" }, EXACTLY_ONE],
      ["empty container object", {}, EXACTLY_ONE],
      ["both selectors empty strings", { elementId: "", text: "" }, EXACTLY_ONE],
    ])("%s", (_name, container, expected) => {
      const tapAny = createTapAnyElement(new FakeElementSelector(makeElement()));
      const error = (tapAny as any).validateOptions({ action: "tap", container });
      if (expected === null) {
        expect(error).toBeNull();
      } else {
        expect(error).toContain(expected);
      }
    });
  });

  describe("findClickableElement", () => {
    test("delegates to selectClickable", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.element).not.toBeNull();
      expect(result.containerFound).toBe(true);
    });

    test("passes selectionStrategy to selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      (tapAny as any).findClickableElement(
        { action: "tap", selectionStrategy: "random" },
        { hierarchy: { node: {} } },
      );

      expect(selector.lastStrategy).toBe("random");
    });

    test("forwards scrollableContainer=true to the selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      (tapAny as any).findClickableElement(
        { action: "tap", scrollableContainer: true },
        { hierarchy: { node: {} } },
      );

      expect(selector.lastScrollableContainer).toBe(true);
    });

    test("leaves scrollableContainer unset when not requested", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      (tapAny as any).findClickableElement({ action: "tap" }, { hierarchy: { node: {} } });

      expect(selector.lastScrollableContainer).toBeUndefined();
    });

    test("returns null element when selector returns null", () => {
      const selector = new FakeElementSelector(null);
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.element).toBeNull();
    });

    test("filters out element whose center is off-screen", () => {
      const offScreenElement = {
        bounds: { left: -200, top: -200, right: -100, bottom: -100 },
        text: "Hidden",
        clickable: "true",
      } as any;
      const selector = new FakeElementSelector(offScreenElement);
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
        { width: 1080, height: 1920 },
      );

      expect(result.element).toBeNull();
    });

    test("keeps element whose center is on-screen", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
        { width: 1080, height: 1920 },
      );

      expect(result.element).not.toBeNull();
    });

    test("keeps element when screenSize is not provided", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
      );

      expect(result.element).not.toBeNull();
    });
  });
});

test.each([false, true])(
  "cached miss then fresh hit reports its coordinate capture (transient failure=%s)",
  async (failFirstCapture) => {
    const { DefaultHierarchyCapture, getHierarchySnapshot } =
      await import("../../../src/features/observe/HierarchyCapture");
    const { CountingIdGenerator } = await import("../../../src/utils/IdGenerator");
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbClient();
    const requests: string[] = [];
    const fresh = {
      screenWidth: 500,
      screenHeight: 500,
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 500, bottom: 500 },
          node: {
            text: "Continue",
            clickable: true,
            "resource-id": "app:id/continue",
            bounds: { left: 200, top: 100, right: 300, bottom: 160 },
          },
        },
      },
    };
    const capture = new DefaultHierarchyCapture(
      "android",
      {
        readCached: async () => {
          throw new Error("fresh request required");
        },
        readFresh: async (request) => {
          requests.push(request.freshness);
          if (failFirstCapture && requests.length === 1) {
            throw new Error("temporary capture failure");
          }
          expect(request.timeoutMs).toBeGreaterThan(0);
          expect(request.timeoutMs).toBeLessThanOrEqual(400);
          return fresh;
        },
        projectVisible: (value) => value,
      },
      timer,
      new CountingIdGenerator(),
    );
    const tapAny = new TapAnyElement(
      { deviceId: "capture-tapany", name: "Test", platform: "android" },
      adb as any,
      { timer, hierarchyCapture: capture },
    );
    const cached = {
      observationId: "old-capture",
      screenSize: { width: 100, height: 100 },
      viewHierarchy: { hierarchy: { node: {} } },
    };
    (tapAny as any).observedInteraction = (action: (result: any) => Promise<unknown>) =>
      action(cached);
    const result = await tapAny.execute({ action: "tap", searchUntil: { duration: 500 } });
    expect(result.success).toBe(true);
    expect(requests).toEqual(failFirstCapture ? ["fresh", "fresh"] : ["fresh"]);
    expect(result.element["resource-id"]).toBe("app:id/continue");
    expect(result.element.bounds.left).toBe(200);
    expect(adb.getCommandCalls().map((call) => call.command)).toContain("shell input tap 250 130");
    const snapshot = getHierarchySnapshot(fresh);
    expect(result.captureId).toBeDefined();
    expect(result.captureId).not.toBe("old-capture");
    expect(result.captureId).toBe(snapshot?.captureId);
  },
);
