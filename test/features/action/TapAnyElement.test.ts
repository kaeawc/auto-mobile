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
