import { describe, test } from "bun:test";
import fc from "fast-check";
import type { Element } from "../../src/models/Element";
import {
  buildContainerFromElement,
  hasAccessibilityAction,
  isClickableElementProperties,
  isTruthyFlag,
} from "../../src/utils/elementProperties";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
// The four string fields buildContainerFromElement inspects, in priority order.
const optString = fc.option(fc.string({ maxLength: 10 }), { nil: undefined });

describe("isTruthyFlag (property-based)", () => {
  test('is true for exactly `true` and "true", false for everything else', () => {
    fc.assert(
      fc.property(
        fc.anything(),
        (value) => isTruthyFlag(value) === (value === true || value === "true"),
      ),
      RUN_OPTIONS,
    );
  });
});

describe("hasAccessibilityAction (property-based)", () => {
  test("agrees with Array.includes for arrays and is false for non-arrays", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (actions, action) => {
        return hasAccessibilityAction(actions, action) === actions.includes(action);
      }),
      RUN_OPTIONS,
    );
  });

  test("never throws and is always a boolean for arbitrary input", () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.string(),
        (value, action) => typeof hasAccessibilityAction(value, action) === "boolean",
      ),
      RUN_OPTIONS,
    );
  });

  test("an array containing the action is always reported", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (rest, action) =>
        hasAccessibilityAction([...rest, action], action),
      ),
      RUN_OPTIONS,
    );
  });
});

describe("isClickableElementProperties (property-based)", () => {
  test('equals the OR of a truthy `clickable` flag and a "click" action', () => {
    const props = fc.record({
      clickable: fc.option(fc.oneof(fc.boolean(), fc.string({ maxLength: 6 })), { nil: undefined }),
      actions: fc.option(fc.array(fc.string({ maxLength: 6 })), { nil: undefined }),
    });
    fc.assert(
      fc.property(props, (p) => {
        const expected = isTruthyFlag(p.clickable) || hasAccessibilityAction(p.actions, "click");
        return isClickableElementProperties(p) === expected;
      }),
      RUN_OPTIONS,
    );
  });

  test('a `clickable: true` flag or a "click" action each force clickable', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 })), (actions) => {
        return (
          isClickableElementProperties({ clickable: true, actions }) &&
          isClickableElementProperties({ actions: [...actions, "click"] })
        );
      }),
      RUN_OPTIONS,
    );
  });
});

describe("buildContainerFromElement (property-based)", () => {
  test("resource-id takes priority and maps to elementId", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        optString,
        optString,
        (rid, text, cd) => {
          const el = { bounds, "resource-id": rid, text, "content-desc": cd } as Element;
          const container = buildContainerFromElement(el);
          return container !== null && container.elementId === rid && container.text === undefined;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("returns null exactly when all four identifying fields are absent/empty", () => {
    fc.assert(
      fc.property(fc.constantFrom("", undefined), (value) => {
        const el = {
          bounds,
          "resource-id": value,
          text: value,
          "content-desc": value,
          "ios-accessibility-label": value,
        } as Element;
        return buildContainerFromElement(el) === null;
      }),
      RUN_OPTIONS,
    );
  });

  test("a non-null result carries exactly one key", () => {
    const field = fc.constantFrom("resource-id", "text", "content-desc", "ios-accessibility-label");
    fc.assert(
      fc.property(field, fc.string({ minLength: 1, maxLength: 10 }), (key, val) => {
        const el = { bounds, [key]: val } as Element;
        const container = buildContainerFromElement(el);
        return container !== null && Object.keys(container).length === 1;
      }),
      RUN_OPTIONS,
    );
  });
});
