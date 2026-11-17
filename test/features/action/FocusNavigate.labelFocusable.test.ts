import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  pinnedFocusOptions,
  SelectorDpadTargetResolver,
} from "../../../src/features/action/DpadTargetResolver";
import { FocusNavigate, type FocusKeyPresser } from "../../../src/features/action/FocusNavigate";
import { createFocusNavigateObserver } from "../../../src/features/action/FocusNavigateObserver";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
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
