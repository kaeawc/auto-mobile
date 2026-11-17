import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  pinnedFocusOptions,
  SelectorDpadTargetResolver,
} from "../../../src/features/action/DpadTargetResolver";
import {
  FocusNavigate,
  firstMatchTarget,
  type FocusKeyPresser,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import { createFocusNavigateObserver } from "../../../src/features/action/FocusNavigateObserver";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { Element } from "../../../src/models/Element";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../../fakes/FakeTimer";

const capture = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-focus/sound-settings-ring-volume-focused.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { viewHierarchy: ViewHierarchyResult };

class SoundSettings implements Pick<ObserveScreen, "execute">, FocusKeyPresser {
  readonly keys: InputKeyName[] = [];

  async execute(): Promise<ObserveResult> {
    return { viewHierarchy: capture.viewHierarchy } as ObserveResult;
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    return { success: true };
  }
}

test.each(["pinned", "firstMatch"] as const)(
  "%s prefers the focused Ring volume seekbar over its non-focusable title",
  async (path) => {
    const device = new SoundSettings();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const until = { label: "Ring volume" };
    const options =
      path === "pinned"
        ? pinnedFocusOptions(until, new SelectorDpadTargetResolver(new ResolverElementSelector()))
        : { firstMatch: true };
    const result = await new FocusNavigate(
      createFocusNavigateObserver(device),
      device,
      timer,
    ).execute({ until, ...options, maxSteps: 0 });

    expect(result).toMatchObject({
      status: "focused",
      success: true,
      steps: 0,
      focusedElement: {
        resourceId: "android:id/seekbar",
        bounds: { left: 189, top: 1341, right: 1038, bottom: 1467 },
      },
    });
    expect(device.keys).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  },
);

const element = (fields: Partial<Element> & Pick<Element, "bounds">): Element => fields;
const flat = (...elements: Element[]): FocusScreen => ({ focused: null, elements });

const moviesLabel = element({
  bounds: { left: 10, top: 10, right: 200, bottom: 90 },
  text: "Movies",
});
const moviesRow = element({
  bounds: { left: 0, top: 0, right: 500, bottom: 100 },
  focusable: true,
});
const moviesPlus = element({
  bounds: { left: 600, top: 0, right: 650, bottom: 20 },
  text: "Movies Plus",
  focusable: true,
});

test("firstMatchTarget keeps a label its focusable row owns over a focusable contains match", () => {
  expect(firstMatchTarget(flat(moviesRow, moviesLabel, moviesPlus), { label: "Movies" })).toEqual({
    label: "Movies",
    atBounds: moviesLabel.bounds,
  });
});

test("firstMatchTarget moves an ownerless label to a focusable match, exact before contains", () => {
  const title = element({ bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Play" });
  const play = element({
    bounds: { left: 0, top: 100, right: 300, bottom: 200 },
    "content-desc": "Play",
    focusable: true,
  });
  const playAll = element({
    bounds: { left: 0, top: 60, right: 20, bottom: 70 },
    text: "Play all",
    focusable: true,
  });
  expect(firstMatchTarget(flat(title, playAll, play), { label: "play" }).atBounds).toEqual(
    play.bounds,
  );
});

test("firstMatchTarget keeps an ownerless label when nothing focusable matches", () => {
  const title = element({ bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Play" });
  expect(firstMatchTarget(flat(title), { label: "Play" }).atBounds).toEqual(title.bounds);
});

test("firstMatchTarget keeps a clickable, non-focusable child's bounds inside a focusable row", () => {
  const row = element({ bounds: { left: 0, top: 0, right: 1000, bottom: 100 }, focusable: true });
  const remove = element({
    bounds: { left: 800, top: 20, right: 980, bottom: 80 },
    text: "Delete",
    clickable: true,
    focusable: false,
  });
  const other = element({
    bounds: { left: 0, top: 300, right: 300, bottom: 400 },
    "content-desc": "Delete",
    focusable: true,
  });
  expect(firstMatchTarget(flat(row, remove, other), { label: "Delete" }).atBounds).toEqual(
    remove.bounds,
  );
});

test("firstMatchTarget keeps a label whose nearest actionable owner is only clickable", () => {
  const row = element({ bounds: { left: 0, top: 0, right: 1000, bottom: 100 }, focusable: true });
  const button = element({
    bounds: { left: 800, top: 20, right: 980, bottom: 80 },
    clickable: true,
  });
  const title = element({ bounds: { left: 810, top: 30, right: 970, bottom: 70 }, text: "Remove" });
  const other = element({
    bounds: { left: 0, top: 300, right: 300, bottom: 400 },
    "content-desc": "Remove",
    focusable: true,
  });
  expect(firstMatchTarget(flat(row, button, title, other), { label: "Remove" }).atBounds).toEqual(
    title.bounds,
  );
});
