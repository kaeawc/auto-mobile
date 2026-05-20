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
    }
  );
};

const makeElement = () => ({
  bounds: { left: 10, top: 20, right: 110, bottom: 70 },
  text: "ListItem",
  clickable: "true",
} as any);

describe("TapAnyElement", () => {
  describe("validation", () => {
    test("rejects container with both elementId and text", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);
      const error = (tapAny as any).validateOptions({
        action: "tap",
        container: { elementId: "com.app:id/list", text: "List" },
      });
      expect(error).toContain("container must specify exactly one");
    });

    test("accepts no container", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);
      const error = (tapAny as any).validateOptions({ action: "tap" });
      expect(error).toBeNull();
    });

    test("accepts container with elementId only", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);
      const error = (tapAny as any).validateOptions({
        action: "tap",
        container: { elementId: "com.app:id/list" },
      });
      expect(error).toBeNull();
    });

    test("accepts container with text only", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);
      const error = (tapAny as any).validateOptions({
        action: "tap",
        container: { text: "My List" },
      });
      expect(error).toBeNull();
    });
  });

  describe("findClickableElement", () => {
    test("delegates to selectClickable", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } }
      );

      expect(result.element).not.toBeNull();
      expect(result.containerFound).toBe(true);
    });

    test("passes selectionStrategy to selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      (tapAny as any).findClickableElement(
        { action: "tap", selectionStrategy: "random" },
        { hierarchy: { node: {} } }
      );

      expect(selector.lastStrategy).toBe("random");
    });

    test("passes scrollableContainer option", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      (tapAny as any).findClickableElement(
        { action: "tap", scrollableContainer: true },
        { hierarchy: { node: {} } }
      );

      expect(selector.lastStrategy).toBeUndefined();
    });

    test("returns null element when selector returns null", () => {
      const selector = new FakeElementSelector(null);
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } }
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
        { width: 1080, height: 1920 }
      );

      expect(result.element).toBeNull();
    });

    test("keeps element whose center is on-screen", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } },
        { width: 1080, height: 1920 }
      );

      expect(result.element).not.toBeNull();
    });

    test("keeps element when screenSize is not provided", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapAny = createTapAnyElement(selector);

      const result = (tapAny as any).findClickableElement(
        { action: "tap" },
        { hierarchy: { node: {} } }
      );

      expect(result.element).not.toBeNull();
    });
  });
});
