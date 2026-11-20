import { describe, expect, test } from "bun:test";
import { scopeToInputLayer } from "../../../../src/features/action/sendkeys/inputLayerScope";
import { findFocusedElement } from "../../../../src/features/observe/HierarchyFocus";
import {
  capturedFocusedFieldsUnderPrototype,
  observationOf,
} from "../../../helpers/prototypeWindowCapture";

function observation(prototypeWindowFocused: boolean) {
  const hierarchy = capturedFocusedFieldsUnderPrototype({
    appText: "display",
    prototypeText: "Buy milk",
    prototypeWindowFocused,
  });
  return {
    ...observationOf(hierarchy),
    focusedElement: findFocusedElement(hierarchy) ?? undefined,
  };
}

describe("scopeToInputLayer (#18895)", () => {
  test("no layer on Android scopes to a prototype window holding input focus", () => {
    const scoped = scopeToInputLayer(observation(true), undefined, "android");
    expect(scoped.focusedElement?.text).toBe("Buy milk");
  });

  test("no layer keeps the whole capture while the app window holds input focus", () => {
    const input = observation(false);
    expect(scopeToInputLayer(input, undefined, "android")).toBe(input);
  });

  test("an explicit app layer is not redirected to the focused prototype", () => {
    const input = observation(true);
    expect(scopeToInputLayer(input, "app", "android")).toBe(input);
  });

  test("an explicit prototype layer scopes to the prototype", () => {
    const scoped = scopeToInputLayer(observation(false), "prototype", "android");
    expect(scoped.focusedElement?.text).toBe("Buy milk");
  });

  test("a prototype layer without a hierarchy drops the focused elements", () => {
    const input = { ...observation(true), viewHierarchy: undefined };
    expect(scopeToInputLayer(input, "prototype", "android").focusedElement).toBeUndefined();
  });
});
