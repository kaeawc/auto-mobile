import { beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { ResolverElementSelector } from "../../src/features/utility/ResolverElementSelector";
import type { Element } from "../../src/models/Element";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import { FakeElementSelector } from "../fakes/FakeElementSelector";
import { runElementSelectorContract } from "./ElementSelectorContract";

// Captured from the Android playground (TapOnElement.selectionStrategy uses the same file).
const capture: ViewHierarchyResult = JSON.parse(
  readFileSync(
    new URL("../fixtures/android-focus/playground-text-field-pre-tap.json", import.meta.url),
    "utf8",
  ),
).viewHierarchy;
const presentText = "Basic Text Field";
const absentText = "No Such Label";
const someElement: Element = {
  text: presentText,
  bounds: { left: 0, top: 0, right: 10, bottom: 10 },
};

// First resolution pays one-time module and projection costs; keep them out of the test budget.
beforeAll(() => {
  new ResolverElementSelector().select(capture, { text: presentText });
});

runElementSelectorContract("FakeElementSelector", () => {
  const selector = new FakeElementSelector();
  return {
    selector,
    capture,
    presentText,
    absentText,
    arm: (hit) => selector.setNextElement(hit ? someElement : null),
  };
});

runElementSelectorContract("ResolverElementSelector", () => ({
  selector: new ResolverElementSelector(),
  capture,
  presentText,
  absentText,
  arm: () => {},
}));
