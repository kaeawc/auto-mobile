import { describe, expect, test } from "bun:test";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { createHierarchyForTest } from "../observe/observeScreenTestBuilders";
import {
  contactsCreateContactHierarchy,
  contactsPhoneFieldBounds,
} from "../../fixtures/observe/android-contacts-create-contact";

/** The option set sendKeys' focus lookup passes for a text selector. */
const focusText = {
  partialMatch: true,
  caseSensitive: false,
  intentAction: "focus-input" as const,
  allowHintFallback: true,
};

describe("a text selector names an input by its hint sublabel (#17463)", () => {
  test("observe projects the Phone field as label +1, sublabel Phone (Mobile)", () => {
    const elements = new DefaultObserveElementCollector().collect(
      contactsCreateContactHierarchy(),
      "android",
    );
    const phone = projectSkeleton(elements!).skeleton.find(
      (row) => row.bounds.join(",") === "126,1862,954,2030",
    );
    expect(phone).toMatchObject({
      label: "+1",
      sublabel: "Phone (Mobile)",
      affordances: ["tap", "long-press", "input"],
    });
  });

  test("focus resolves Phone to the field beside a non-editable Phone icon", () => {
    const selected = new ResolverElementSelector().select(
      contactsCreateContactHierarchy(),
      { text: "Phone" },
      focusText,
    );
    expect(selected.element?.bounds).toEqual(contactsPhoneFieldBounds);
    expect(selected.element?.text).toBe("+1");
  });

  test("the full hint matches exactly", () => {
    const selected = new ResolverElementSelector().select(
      contactsCreateContactHierarchy(),
      { text: "phone (mobile)" },
      focusText,
    );
    expect(selected.element?.bounds).toEqual(contactsPhoneFieldBounds);
  });

  test("a clickable non-editable match does not block the hint tier for focus", () => {
    const capture = createHierarchyForTest({
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            {
              bounds: { left: 20, top: 2100, right: 400, bottom: 2180 },
              class: "android.widget.Button",
              text: "Add phone",
              clickable: true,
            },
            {
              bounds: contactsPhoneFieldBounds,
              class: "android.widget.EditText",
              text: "+1",
              "hint-text": "Phone (Mobile)",
              focusable: true,
              clickable: true,
            },
          ],
        },
      },
    });
    const selector = new ResolverElementSelector();
    expect(selector.select(capture, { text: "Phone" }, focusText).element?.text).toBe("+1");
    // A tap keeps the primary text tier: the button that says "phone" is still the tap target.
    expect(
      selector.select(capture, { text: "Phone" }, { ...focusText, intentAction: "tap" }).element
        ?.text,
    ).toBe("Add phone");
  });

  test("an editable primary match still wins over another field's hint", () => {
    const capture = createHierarchyForTest({
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            {
              bounds: { left: 0, top: 100, right: 500, bottom: 200 },
              class: "android.widget.EditText",
              text: "Phone",
              focusable: true,
            },
            {
              bounds: contactsPhoneFieldBounds,
              class: "android.widget.EditText",
              text: "+1",
              "hint-text": "Phone (Mobile)",
              focusable: true,
            },
          ],
        },
      },
    });
    expect(
      new ResolverElementSelector().select(capture, { text: "Phone" }, focusText).element?.text,
    ).toBe("Phone");
  });

  test("without the hint opt-in the focus lookup still misses", () => {
    expect(
      new ResolverElementSelector().select(
        contactsCreateContactHierarchy(),
        { text: "Phone" },
        { ...focusText, allowHintFallback: false },
      ).element,
    ).toBeNull();
  });
});
