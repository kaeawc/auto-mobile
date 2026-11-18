import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  pinnedFocusOptions,
  SelectorDpadTargetResolver,
} from "../../../src/features/action/DpadTargetResolver";
import {
  firstMatchTarget,
  FocusNavigate,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import { focusLabelSibling } from "../../../src/features/action/FocusNavigateMatching";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { isTruthyFlag } from "../../../src/features/utility/elementProperties";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../../fakes/FakeTimer";

const hierarchy = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-focus/playground-control-shapes-slider-focused.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ViewHierarchyResult;
const elements = new DefaultElementParser()
  .flattenViewHierarchy(hierarchy)
  .map(({ element }) => element);
const slider = elements.find((element) => element["resource-id"] === "readout_less_slider")!;
const resolver = new SelectorDpadTargetResolver(new ResolverElementSelector());
const sliderBounds = { left: 16, top: 1317, right: 1064, bottom: 1433 };

test.each(["selector", "hierarchy", "flat"] as const)(
  "%s pins the captured Readout-less slider label to its following control",
  (path) => {
    expect(slider).toBeDefined();
    expect(isTruthyFlag(slider.focused)).toBe(true);
    const screen: FocusScreen = {
      focused: slider,
      elements,
      ...(path === "flat" ? {} : { hierarchy }),
    };
    const target = { label: "Readout-less slider" };
    expect(
      path === "selector"
        ? resolver.resolve(screen, target)
        : firstMatchTarget(screen, target).atBounds,
    ).toEqual(sliderBounds);
  },
);

const existingLabels = [
  { label: "Duplicate B", bounds: { left: 901, top: 962, right: 1038, bottom: 1088 } },
  { label: "Flat Bluetooth", bounds: { left: 42, top: 612, right: 179, bottom: 738 } },
  { label: "Back", bounds: { left: 12, top: 158, right: 138, bottom: 284 } },
];

test.each(existingLabels)(
  "selector keeps the captured $label control pinned",
  ({ label, bounds }) => {
    expect(resolver.resolve({ focused: slider, elements, hierarchy }, { label })).toEqual(bounds);
  },
);

test.each(["Readout-less slider", "Back"])(
  "the pinned focus loop accepts the captured %s control in zero steps",
  async (label) => {
    const focused =
      label === "Back"
        ? elements.find((element) => element["resource-id"] === "control_shapes_back")!
        : slider;
    const observer: FocusObserver = { read: async () => ({ focused, elements, hierarchy }) };
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let presses = 0;
    const until = { label };
    const result = await new FocusNavigate(
      observer,
      {
        press: async () => {
          presses++;
          return { success: true };
        },
      },
      timer,
    ).execute({ until, ...pinnedFocusOptions(until, resolver) });
    expect(result.status).toBe("focused");
    expect(result.steps).toBe(0);
    expect(presses).toBe(0);
    expect(result.focusedElement?.bounds).toEqual(focused.bounds);
  },
);

const labelElement: Element = {
  text: "Target",
  bounds: { left: 0, top: 10, right: 50, bottom: 20 },
};
const control: Element = {
  focusable: true,
  bounds: { left: 0, top: 30, right: 50, bottom: 40 },
};
const nextLabel: Element = { ...labelElement, text: "Other" };
const siblingNodes = (...elements: Element[]) => [
  { index: 0, element: { bounds: { left: 0, top: 0, right: 100, bottom: 100 } } },
  ...elements.map((element, index) => ({ element, index: index + 1, parentIndex: 0 })),
];

test("two unlabelled controls before the next label remain ambiguous", () => {
  const nodes = siblingNodes(labelElement, control, { ...control }, nextLabel);
  expect(focusLabelSibling(nodes, nodes[1])).toBeUndefined();
});

test.each(["text", "content-desc"])(
  "an intervening sibling %s prevents order-based ownership",
  (property) => {
    const barrier: Element = { [property]: "Other", bounds: nextLabel.bounds };
    const nodes = siblingNodes(control, labelElement, barrier, { ...control });
    expect(focusLabelSibling(nodes, nodes[2])).toBeUndefined();
  },
);

test("a label cannot claim its following unlabelled control when an earlier candidate exists", () => {
  const nodes = siblingNodes(control, labelElement, { ...control }, nextLabel);
  expect(focusLabelSibling(nodes, nodes[2])).toBeUndefined();
});

test("control-first pairs in a shared parent remain ambiguous for both labels", () => {
  const nodes = siblingNodes(control, labelElement, { ...control }, nextLabel);
  expect(focusLabelSibling(nodes, nodes[2])).toBeUndefined();
  expect(focusLabelSibling(nodes, nodes[4])).toBeUndefined();
});

test("label-first pairs in a shared parent each own their following control", () => {
  const nodes = siblingNodes(labelElement, control, nextLabel, { ...control });
  expect(focusLabelSibling(nodes, nodes[1])).toBe(nodes[2].element);
  expect(focusLabelSibling(nodes, nodes[3])).toBe(nodes[4].element);
});

test.each([
  { name: "a control-first prefix", preceding: [control, labelElement, { ...control }] },
  {
    name: "multiple controls after the previous label",
    preceding: [labelElement, control, { ...control }],
  },
])("$name leaves the next label's following control ambiguous", ({ preceding }) => {
  const nodes = siblingNodes(...preceding, nextLabel, { ...control });
  expect(focusLabelSibling(nodes, nodes[4])).toBeUndefined();
});

test("the single-candidate fallback still permits a control before its label", () => {
  const nodes = siblingNodes(control, labelElement);
  expect(focusLabelSibling(nodes, nodes[2])).toBe(nodes[1].element);
});
