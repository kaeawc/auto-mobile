import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  focusOwnerBounds,
  SelectorDpadTargetResolver,
} from "../../../src/features/action/DpadTargetResolver";
import {
  firstMatchTarget,
  FocusNavigate,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { capturedFlatNodeForTest, createFlatNodeForTest } from "../observe/flatHierarchyBuilders";
import { FakeTimer } from "../../fakes/FakeTimer";

const capture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/android-focus/playground-slider-value-50.json", import.meta.url),
    "utf8",
  ),
) as ViewHierarchyResult;
const hierarchy = capture;
const elements = new DefaultElementParser()
  .flattenViewHierarchy(hierarchy)
  .map(({ element }) => element);
const slider = elements.find((element) => element["resource-id"] === "slider_control")!;
const resolver = new SelectorDpadTargetResolver(new ResolverElementSelector());

test.each(["selector", "hierarchy", "bounds"] as const)(
  "%s pins the captured slider's sibling title to its unlabelled control",
  (path) => {
    expect(slider).toBeDefined();
    const screen: FocusScreen = {
      focused: slider,
      elements,
      ...(path === "bounds" ? {} : { hierarchy }),
    };
    const target = { label: "Slider Value" };
    const bounds =
      path === "selector"
        ? resolver.resolve(screen, target)
        : firstMatchTarget(screen, target).atBounds;
    expect(bounds).toEqual(slider.bounds);
  },
);

const title: Element = { text: "Play", bounds: { left: 10, top: 10, right: 30, bottom: 20 } };
const playAll: Element = {
  text: "Play all",
  focusable: true,
  bounds: { left: 200, top: 200, right: 300, bottom: 240 },
};
const flat = (...nodes: Element[]): FocusScreen => ({ focused: null, elements: nodes });

test("firstMatch considers contains-only focusable matches after selecting an exact title", () => {
  expect(firstMatchTarget(flat(title, playAll), { label: "Play" }).atBounds).toEqual(
    playAll.bounds,
  );
});

test("the focus loop preserves contains-only fallback when it enables exact-first matching", async () => {
  const observer: FocusObserver = {
    read: async () => ({ ...flat(title, playAll), focused: playAll }),
  };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const result = await new FocusNavigate(
    observer,
    { press: async () => ({ success: true }) },
    timer,
  ).execute({ until: { label: "Play" }, firstMatch: true, maxSteps: 0 });
  expect(result.status).toBe("focused");
});

test("an explicitly exact flat target excludes contains-only focusable matches", () => {
  expect(
    firstMatchTarget(flat(title, playAll), { label: "Play", labelExact: true }).atBounds,
  ).toEqual(title.bounds);
});

const scroll: Element = { scrollable: true, bounds: { left: 0, top: 0, right: 100, bottom: 100 } };
const play: Element = { ...playAll, text: "Play" };
const tree = (...nodes: Element[]) => ({
  hierarchy: {
    node: createFlatNodeForTest({
      bounds: { left: 0, top: 0, right: 500, bottom: 500 },
      node: nodes.map((element) => capturedFlatNodeForTest(element)),
    }),
  },
});

test.each(["selector", "flat"] as const)(
  "%s keeps a pure label under a scrollable ancestor over a same-label duplicate",
  (path) => {
    const screen = {
      ...flat(scroll, title, play),
      hierarchy: tree({ ...scroll, node: [title] }, play),
    };
    const bounds =
      path === "selector"
        ? resolver.resolve(screen, { label: "Play" })
        : firstMatchTarget(screen, { label: "Play" }).atBounds;
    expect(bounds).toEqual(title.bounds);
  },
);

test("an exact selector target excludes a contains-only focusable fallback", () => {
  expect(
    resolver.resolve(
      { ...flat(title, playAll), hierarchy: tree(title, playAll) },
      { label: "Play", labelExact: true },
    ),
  ).toEqual(title.bounds);
});

test("focusOwnerBounds filters unrelated focusables out of resolution candidates", () => {
  const nodes = new SearchableHierarchy().project(tree(title, { ...playAll, text: "Stop" }));
  const chosen = nodes.find((entry) => entry.element?.text === "Play")!;
  expect(
    focusOwnerBounds({ chosen, candidates: [...nodes], snapshotNodes: nodes }, "Play"),
  ).toBeUndefined();
});

test("focusOwnerBounds honors exactness while scanning all candidates", () => {
  const nodes = new SearchableHierarchy().project(tree(title, playAll));
  const chosen = nodes.find((entry) => entry.element?.text === "Play")!;
  expect(
    focusOwnerBounds({ chosen, candidates: [...nodes], snapshotNodes: nodes }, "Play", true),
  ).toBeUndefined();
});

test("an overlay's inert label beats a focusable duplicate in a lower window", () => {
  const hierarchy: ViewHierarchyResult = {
    hierarchy: {},
    windows: [
      { windowLayer: 1, hierarchy: tree(play).hierarchy.node },
      { windowLayer: 5, hierarchy: tree(title).hierarchy.node },
    ],
  };
  expect(resolver.resolve({ ...flat(title, play), hierarchy }, { label: "Play" })).toEqual(
    title.bounds,
  );
});

const control: Element = { focusable: true, bounds: { left: 40, top: 10, right: 60, bottom: 30 } };
const row: Element = { bounds: { left: 0, top: 0, right: 100, bottom: 50 } };

test.each(["selector", "flat"] as const)(
  "%s allows only same-parent siblings across a scroll boundary",
  (path) => {
    const hierarchy = tree({ ...scroll, node: [{ ...row, node: [title, control] }] }, play);
    const screen = { ...flat(scroll, row, title, control, play), hierarchy };
    expect(
      path === "selector"
        ? resolver.resolve(screen, { label: "Play" })
        : firstMatchTarget(screen, { label: "Play" }).atBounds,
    ).toEqual(control.bounds);
  },
);

test.each(["own text", "own description", "child label", "different parent"] as const)(
  "sibling fallback excludes a control with %s",
  (kind) => {
    const child: Element = { text: "Other", bounds: { left: 45, top: 15, right: 55, bottom: 25 } };
    const candidate = {
      ...control,
      ...(kind === "own text" ? { text: "Other" } : {}),
      ...(kind === "own description" ? { "content-desc": "Other" } : {}),
      ...(kind === "child label" ? { node: [child] } : {}),
    };
    const hierarchy =
      kind === "different parent"
        ? tree({ ...row, node: [title] }, candidate)
        : tree({ ...row, node: [title, candidate] });
    expect(resolver.resolve({ ...flat(title, candidate), hierarchy }, { label: "Play" })).toEqual(
      title.bounds,
    );
  },
);

test("sibling fallback breaks equal hierarchy-distance ties by hierarchy order", () => {
  const later = { ...control, bounds: { left: 70, top: 10, right: 90, bottom: 30 } };
  const hierarchy = tree({ ...row, node: [control, title, later] });
  expect(
    resolver.resolve({ ...flat(control, title, later), hierarchy }, { label: "Play" }),
  ).toEqual(control.bounds);
});

test("the flat focus loop accepts focus on the captured sibling control", async () => {
  const observer: FocusObserver = { read: async () => ({ focused: slider, elements }) };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const result = await new FocusNavigate(
    observer,
    { press: async () => ({ success: true }) },
    timer,
  ).execute({ until: { label: "Slider Value" }, firstMatch: true, maxSteps: 0 });
  expect(result.status).toBe("focused");
});

test.each(["selector", "flat"] as const)(
  "%s does not treat the scroll container itself as a sibling row",
  (path) => {
    const hierarchy = tree({ ...scroll, node: [title, { ...control, text: "Play" }] });
    const screen = { ...flat(scroll, title, { ...control, text: "Play" }), hierarchy };
    expect(
      path === "selector"
        ? resolver.resolve(screen, { label: "Play" })
        : firstMatchTarget(screen, { label: "Play" }).atBounds,
    ).toEqual(title.bounds);
  },
);

test.each(["hierarchy", "bounds"] as const)(
  "%s excludes an ordinary control's co-located child description",
  (path) => {
    const child = { "content-desc": "Other", bounds: control.bounds };
    const hierarchy = tree({ ...row, node: [title, { ...control, node: [child] }] });
    const screen = {
      ...flat(row, title, control, child),
      ...(path === "hierarchy" ? { hierarchy } : {}),
    };
    expect(firstMatchTarget(screen, { label: "Play" }).atBounds).toEqual(title.bounds);
  },
);
