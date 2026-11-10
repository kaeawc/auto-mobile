import { describe, expect, spyOn } from "bun:test";
import { runBlockWith } from "../../helpers/observedInteractionStub";
import { buildObserveResult } from "../../helpers/observeFixture";
import { warmedTests } from "../../helpers/warmedTests";
import { createFlatNodeForTest } from "../observe/flatHierarchyBuilders";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { serverConfig } from "../../../src/utils/ServerConfig";
import type { ViewHierarchyResult } from "../../../src/models";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

// #17782: the observe App picker taps an element that has no resource id by its text. When the
// picked "Remove" button is gone by the time the user presses tap, the live screen may still
// carry "Remove all", which a substring match would select and tap instead.
const test = warmedTests(() => serverConfig.setRawElementSearchEnabled(false));

const button = (text: string, bounds: string) => ({
  $: { text, class: "android.widget.Button", clickable: "true", bounds },
});

/** A hierarchy of id-less buttons, as the picker sees them. */
function screenWith(...buttons: ReturnType<typeof button>[]): ViewHierarchyResult {
  return {
    hierarchy: {
      node: createFlatNodeForTest({
        $: { class: "android.widget.FrameLayout", bounds: "[0,0][1080,2400]" },
        node: buttons,
      }),
    },
  };
}

const removeAllOnly = screenWith(button("Remove all", "[0,200][540,320]"));
const bothButtons = screenWith(
  button("Remove all", "[0,200][540,320]"),
  button("Remove", "[540,200][1080,320]"),
);

function createTapOn(): TapOnElement {
  return new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" },
    new FakeAdbClient(),
    { timer: new FakeTimer(), elementSelector: new ResolverElementSelector() },
  );
}

const pickerTap = (exactText?: boolean): TapOnElementOptions => ({
  action: "tap",
  text: "Remove",
  selectionStrategy: "unique",
  ...(exactText === undefined ? {} : { exactText }),
});

describe("tapOn exactText (#17782)", () => {
  test("without exactText, a vanished text target falls back to a substring match", () => {
    const { selection } = createTapOn().findElementInHierarchy(pickerTap(), removeAllOnly);
    expect(selection.element?.text).toBe("Remove all");
  });

  test("with exactText, a vanished text target is reported as no longer present", () => {
    expect(() => createTapOn().findElementInHierarchy(pickerTap(true), removeAllOnly)).toThrow(
      "Element with exact text 'Remove' is no longer present; re-observe and pick it again.",
    );
  });

  test("with exactText, the exact element is still selected when present", () => {
    const { selection } = createTapOn().findElementInHierarchy(pickerTap(true), bothButtons);
    expect(selection.element?.text).toBe("Remove");
    expect(selection.totalMatches).toBe(1);
  });

  test("exactText matching stays case-insensitive", () => {
    const { selection } = createTapOn().findElementInHierarchy(
      { ...pickerTap(true), text: "remove" },
      bothButtons,
    );
    expect(selection.element?.text).toBe("Remove");
  });

  test("execute returns the re-observe failure and never taps a different element", async () => {
    const tapOn = createTapOn();
    tapOn.observedInteraction = runBlockWith(() =>
      buildObserveResult({
        updatedAt: 0,
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: removeAllOnly,
        screenSize: { width: 1080, height: 2400 },
      }),
    );
    const dispatch = spyOn(tapOn, "executeAndroidTap");

    const result = await tapOn.execute(pickerTap(true));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Element with exact text 'Remove' is no longer present");
    expect(result.error).toContain("re-observe");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("first-match exactText misses use the same re-observe wording", async () => {
    const tapOn = createTapOn();
    await expect(
      tapOn["handleElementNotFound"]({ action: "tap", text: "Remove", exactText: true }),
    ).rejects.toThrow("Element with exact text 'Remove' is no longer present; re-observe");
  });
});
