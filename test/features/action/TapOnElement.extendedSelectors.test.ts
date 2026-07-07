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
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    {
      timer: new FakeTimer(),
      elementSelector: selector,
    }
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
    }
  );
};

const makeElement = (bounds = { left: 0, top: 0, right: 100, bottom: 50 }) => ({
  bounds,
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
        { hierarchy: { node: {} } }
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastText).toBe("Login");
    });

    test("delegates elementId to selectByResourceId", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { elementId: "com.app:id/btn", action: "tap" },
        { hierarchy: { node: {} } }
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastResourceId).toBe("com.app:id/btn");
    });

    test("text + sibling delegates to selectClickableSiblingOfText", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { text: "Accept Terms", sibling: true, action: "tap" },
        { hierarchy: { node: {} } }
      );

      expect(result.selection.element).not.toBeNull();
      expect(selector.lastText).toBe("Accept Terms");
    });

    test("elementId + sibling delegates to selectClickableSiblingOfResourceId", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      const result = (tapOn as any).findElementInHierarchy(
        { elementId: "com.app:id/label", sibling: true, action: "tap" },
        { hierarchy: { node: {} } }
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
        { hierarchy: { node: {} } }
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
        { hierarchy: { node: {} }, screenWidth: 200, screenHeight: 200 }
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
        { hierarchy: { node: {} }, screenWidth: 200, screenHeight: 200 }
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
                { $: { text: "Done", bounds: { left: -300, top: 0, right: -200, bottom: 50 } } },
                { $: { text: "Done", bounds: { left: 20, top: 20, right: 120, bottom: 70 } } },
                { $: { text: "Add", bounds: { left: 20, top: 90, right: 120, bottom: 140 } } },
              ],
            },
          },
          screenWidth: 200,
          screenHeight: 200,
        }
      );

      expect(result.selection.element?.text).toBe("Done");
      expect(result.selection.element?.bounds).toEqual({ left: 20, top: 20, right: 120, bottom: 70 });
    });

    test("sibling respects selectionStrategy", () => {
      const selector = new FakeElementSelector(makeElement());
      const tapOn = createTapOnElement(selector);

      (tapOn as any).findElementInHierarchy(
        { text: "Email", sibling: true, action: "tap", selectionStrategy: "random" },
        { hierarchy: { node: {} } }
      );

      expect(selector.lastStrategy).toBe("random");
    });
  });
});
