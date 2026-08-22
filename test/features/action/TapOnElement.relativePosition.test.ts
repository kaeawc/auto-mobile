import { describe, expect, spyOn, test } from "bun:test";
import type { Element } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const SPANNABLE_TEXT_ELEMENT: Element = {
  "resource-id": "test:id/spannable_text",
  class: "android.widget.TextView",
  text: "Left link and ordinary text and right link",
  clickable: true,
  bounds: { left: 100, top: 200, right: 500, bottom: 260 },
};

function createHarness(element: Element = SPANNABLE_TEXT_ELEMENT) {
  const accessibilityDetector = new FakeAccessibilityDetector();
  accessibilityDetector.setTalkBackEnabled(false);
  const command = new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    {
      accessibilityDetector,
      timer: new FakeTimer(),
    },
  );
  const observation = {
    viewHierarchy: { hierarchy: {} },
    screenSize: { width: 600, height: 800 },
  } as any;

  spyOn(command as any, "observedInteraction").mockImplementation(async (block: any) => ({
    ...(await block(observation)),
    observation,
  }));
  spyOn(command as any, "searchForElement").mockResolvedValue({
    selection: { element, indexInMatches: 0, totalMatches: 1, strategy: "first" },
    viewHierarchy: observation.viewHierarchy,
    containerFound: true,
    stats: { durationMs: 0, requestCount: 1, changeCount: 0 },
  });
  spyOn(command as any, "resolveTapTargetElement").mockReturnValue({
    element,
    usedParent: false,
  });
  spyOn((command as any).strategy, "isAccessibilityServiceEnabled").mockResolvedValue(false);
  spyOn((command as any).selectionStateTracker, "prepare").mockResolvedValue(null);
  spyOn((command as any).selectionStateTracker, "finalize").mockResolvedValue([]);
  const executeAndroidTap = spyOn(command as any, "executeAndroidTap").mockResolvedValue(undefined);

  return { command, executeAndroidTap, observation };
}

describe("TapOnElement relative position", () => {
  test.each([
    ["left-edge ClickableSpan", { x: 0.02, y: 0.5 }, { x: 108, y: 230 }],
    ["right-edge ClickableSpan", { x: 0.98, y: 0.5 }, { x: 491, y: 230 }],
  ] as const)(
    "targets a %s at the resolved coordinate",
    async (_label, relativePosition, expected) => {
      const { command, executeAndroidTap } = createHarness();

      const result = await command.execute({
        action: "tap",
        elementId: "test:id/spannable_text",
        relativePosition,
      });

      expect(result).toMatchObject({ success: true, ...expected });
      expect(executeAndroidTap).toHaveBeenCalledWith(
        "tap",
        expected.x,
        expected.y,
        expect.any(Number),
        SPANNABLE_TEXT_ELEMENT,
        undefined,
        expect.objectContaining({ relativePosition }),
        false,
      );
    },
  );

  test("preserves center tapping when relativePosition is omitted", async () => {
    const { command, executeAndroidTap } = createHarness();

    const result = await command.execute({
      action: "tap",
      elementId: "test:id/spannable_text",
    });

    expect(result).toMatchObject({ success: true, x: 300, y: 230 });
    expect(executeAndroidTap).toHaveBeenCalledWith(
      "tap",
      300,
      230,
      expect.any(Number),
      SPANNABLE_TEXT_ELEMENT,
      undefined,
      expect.not.objectContaining({ relativePosition: expect.anything() }),
      false,
    );
  });

  test("resolves against the stable final element bounds", async () => {
    const { command, executeAndroidTap, observation } = createHarness();
    const stableElement = {
      ...SPANNABLE_TEXT_ELEMENT,
      bounds: { left: 200, top: 300, right: 600, bottom: 360 },
    };
    spyOn(command as any, "resolveAndroidStableTapTargetAfterRefreshes").mockResolvedValue({
      ok: true,
      viewHierarchy: observation.viewHierarchy,
      tapElement: stableElement,
      usedParent: false,
    });

    const result = await command.execute({
      action: "tap",
      elementId: "test:id/spannable_text",
      relativePosition: { x: 0, y: 1 },
      preTapStability: true,
    });

    expect(result).toMatchObject({ success: true, x: 200, y: 359 });
    expect(executeAndroidTap).toHaveBeenCalledWith(
      "tap",
      200,
      359,
      expect.any(Number),
      stableElement,
      undefined,
      expect.anything(),
      false,
    );
  });

  test("rejects a resolved point outside the screen before device contact", () => {
    const partiallyOffscreen = {
      ...SPANNABLE_TEXT_ELEMENT,
      bounds: { left: -40, top: 200, right: 360, bottom: 260 },
    };
    const { command, executeAndroidTap } = createHarness(partiallyOffscreen);

    expect(() =>
      (command as any).resolveTapPoint(
        partiallyOffscreen,
        { width: 600, height: 800 },
        { x: 0, y: 0.5 },
      ),
    ).toThrow("outside screen bounds");
    expect(executeAndroidTap).not.toHaveBeenCalled();
  });

  test("rejects a target for an element without an addressable pixel", () => {
    const zeroWidth = {
      ...SPANNABLE_TEXT_ELEMENT,
      bounds: { left: 100, top: 200, right: 100, bottom: 260 },
    };
    const { command, executeAndroidTap } = createHarness(zeroWidth);

    expect(() =>
      (command as any).resolveTapPoint(zeroWidth, { width: 600, height: 800 }, { x: 0.5, y: 0.5 }),
    ).toThrow("valid element bounds");
    expect(executeAndroidTap).not.toHaveBeenCalled();
  });

  test("rejects relative positioning on iOS and for focus actions", () => {
    const { command } = createHarness();

    expect(
      (command as any).validateOptions({
        action: "tap",
        elementId: "test:id/spannable_text",
        relativePosition: { x: 0.5, y: 0.5 },
      }),
    ).toBeNull();

    (command as any).device.platform = "ios";
    expect(
      (command as any).validateOptions({
        action: "tap",
        elementId: "test:id/spannable_text",
        relativePosition: { x: 0.5, y: 0.5 },
      }),
    ).toContain("Android");

    (command as any).device.platform = "android";
    expect(
      (command as any).validateOptions({
        action: "focus",
        elementId: "test:id/spannable_text",
        relativePosition: { x: 0.5, y: 0.5 },
      }),
    ).toContain("focus");
  });
});
