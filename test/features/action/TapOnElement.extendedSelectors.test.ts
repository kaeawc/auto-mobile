import { describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";

const createTapOnElement = (selector: FakeElementSelector) => {
  return new TapOnElement(
    {
      name: "test-device",
      platform: "android",
      id: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    {
      timer: new FakeTimer(),
      elementSelector: selector,
    }
  );
};

const makeElement = () => ({
  bounds: { left: 0, top: 0, right: 100, bottom: 50 },
  text: "Item",
  clickable: "true",
} as any);

describe("TapOnElement extended selectors", () => {
  describe("validation", () => {
    test("rejects when no selector provided", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({ action: "tap" });
      expect(error).toContain("requires exactly one");
    });

    test("rejects when multiple selectors provided", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        text: "Login",
        clickable: true,
      });
      expect(error).toContain("requires exactly one");
    });

    test("accepts clickable as sole selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        clickable: true,
      });
      expect(error).toBeNull();
    });

    test("accepts siblingOfText as sole selector", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const error = (tapOn as any).validateOptions({
        action: "tap",
        siblingOfText: "Label",
      });
      expect(error).toBeNull();
    });
  });

  describe("findElementInHierarchy", () => {
    test("delegates siblingOfText to selectClickableSiblingOfText", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { siblingOfText: "Email", action: "tap" },
        { hierarchy: { node: {} } }
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastText).toBe("Email");
    });

    test("delegates tapClickableParent to selectClickableParentByText", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { text: "John Smith", tapClickableParent: true, action: "tap" },
        { hierarchy: { node: {} } }
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastText).toBe("John Smith");
    });

    test("delegates clickable to selectClickable", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { clickable: true, action: "tap" },
        { hierarchy: { node: {} } }
      );

      expect(result.selection.element).not.toBeNull();
    });

    test("clickable respects selectionStrategy", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      (tapOn as any).findElementInHierarchy(
        { clickable: true, action: "tap", selectionStrategy: "random" },
        { hierarchy: { node: {} } }
      );

      expect(selector.lastStrategy).toBe("random");
    });
  });

  describe("resolveAndroidLabelRowOverlapBoundsForClickableParent", () => {
    test("returns intersection rect of row and label text", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: { bounds: "[0,0][1080,1920]" },
            node: [
              {
                $: { clickable: "true", bounds: "[0,700][1080,800]" }
              },
              {
                $: { text: "Dan Corkill", bounds: "[48,715][300,785]" }
              }
            ]
          }
        }
      } as any;
      const row = {
        bounds: { left: 0, top: 700, right: 1080, bottom: 800 },
        clickable: "true"
      } as any;
      const r = (tapOn as any).resolveAndroidLabelRowOverlapBoundsForClickableParent(
        { text: "Dan Corkill", action: "tap", tapClickableParent: true },
        row,
        viewHierarchy
      );
      expect(r).toEqual({ left: 48, top: 715, right: 300, bottom: 785 });
    });
  });

  describe("resolveAndroidCoordinateTapPointForClickableParent", () => {
    test("uses center of text bounds intersected with row bounds", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: { bounds: "[0,0][1080,1920]" },
            node: [
              {
                $: { clickable: "true", bounds: "[0,700][1080,800]" }
              },
              {
                $: { text: "Dan Corkill", bounds: "[48,715][300,785]" }
              }
            ]
          }
        }
      } as any;
      const row = {
        bounds: { left: 0, top: 700, right: 1080, bottom: 800 },
        clickable: "true"
      } as any;
      const p = (tapOn as any).resolveAndroidCoordinateTapPointForClickableParent(
        { text: "Dan Corkill", action: "tap", tapClickableParent: true },
        row,
        viewHierarchy
      );
      expect(p).toEqual({ x: 174, y: 750 });
    });

    test("when row clips wide text, prefers text center clamped to row inside overlap", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: { bounds: "[0,0][1080,1920]" },
            node: [
              {
                $: { clickable: "true", bounds: "[0,700][120,800]" }
              },
              {
                $: { text: "Dan Corkill", bounds: "[48,715][300,785]" }
              }
            ]
          }
        }
      } as any;
      const row = {
        bounds: { left: 0, top: 700, right: 120, bottom: 800 },
        clickable: "true"
      } as any;
      const p = (tapOn as any).resolveAndroidCoordinateTapPointForClickableParent(
        { text: "Dan Corkill", action: "tap", tapClickableParent: true },
        row,
        viewHierarchy
      );
      // Overlap center would be ~(84, 750); text bbox center is ~(174, 750), clamped to row interior → x=117
      expect(p).toEqual({ x: 117, y: 750 });
    });

    test("falls back to row center when label text is not in hierarchy", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);
      const row = {
        bounds: { left: 0, top: 700, right: 1080, bottom: 800 },
        clickable: "true"
      } as any;
      const p = (tapOn as any).resolveAndroidCoordinateTapPointForClickableParent(
        { text: "Nobody", action: "tap", tapClickableParent: true },
        row,
        { hierarchy: { node: { $: { bounds: "[0,0][1080,1920]" } } } } as any
      );
      expect(p).toEqual({ x: 540, y: 750 });
    });
  });
});
