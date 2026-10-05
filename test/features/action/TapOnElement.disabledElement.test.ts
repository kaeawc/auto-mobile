import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidControlObservation } from "../../helpers/androidDisabledControlCapture";

const disabledWarning = "The matched element is disabled; the tap may have no effect.";

function createCommand(state: "disabled" | "enabled", talkBackUnknown = false) {
  const observation = androidControlObservation(state);
  const node = observation.viewHierarchy?.hierarchy.node;
  if (!node || Array.isArray(node)) {
    throw new Error("Expected converted captured control node");
  }
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbExecutor();
  const service = new FakeCtrlProxy(timer);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(service);
  const detector = new FakeAccessibilityDetector();
  detector.setDefaultResult(talkBackUnknown ? null : false);
  const command = new TapOnElement(
    { name: "Fake Android", deviceId: "fake-android", platform: "android" },
    adb,
    {
      timer,
      accessibilityDetector: detector,
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  // Exercise real resolution and dispatch; replace only the surrounding observation loop.
  spyOn(command, "observedInteraction").mockImplementation(async (block) =>
    block(recordObservationRead(observation)),
  );
  return { command, service, adb, observation, node };
}

afterEach(() => {
  mock.restore();
});

describe("Android tapOn disabled captured control", () => {
  test.each(["tap", "doubleTap", "longPress"] as const)(
    "%s still dispatches and succeeds with a disabled warning",
    async (action) => {
      const { command, service, adb, node } = createCommand("disabled");
      expect(node.enabled).toBe("false");
      const result = await command.execute({ action, text: "Disabled" });
      expect(result.success).toBe(true);
      if (action === "longPress") {
        expect(adb.getExecutedCommands()).toContain(
          "shell input touchscreen swipe 517 1479 517 1479 500",
        );
      } else {
        expect(service.getTapHistory()).toEqual(
          Array.from({ length: action === "doubleTap" ? 2 : 1 }, () => ({
            x: 517,
            y: 1479,
            duration: 10,
          })),
        );
      }
      expect(result.warnings).toContain(disabledWarning);
    },
  );

  test("boolean false on a cloned captured node still dispatches with a warning", async () => {
    const { command, service, observation, node } = createCommand("disabled");
    expect(node.enabled).toBe("false");
    const clonedNode = structuredClone(node);
    clonedNode.enabled = false;
    if (!observation.viewHierarchy) {
      throw new Error("Expected converted captured hierarchy");
    }
    observation.viewHierarchy.hierarchy.node = clonedNode;
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(node.enabled).toBe("false");
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toHaveLength(1);
    expect(result.warnings).toContain(disabledWarning);
  });

  test.each([undefined, true, "true"] as const)("enabled=%s emits no warning", async (enabled) => {
    const { command, service, node } = createCommand("enabled");
    if (enabled !== undefined) {
      node.enabled = enabled;
    }
    expect(node.enabled).toBe(enabled);
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toHaveLength(1);
    expect(result.warnings).toBeUndefined();
  });

  test("preserves the unknown TalkBack warning alongside the disabled warning", async () => {
    const { command, service, node } = createCommand("disabled", true);
    expect(node.enabled).toBe("false");
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toHaveLength(1);
    expect(result.warnings).toContain(disabledWarning);
    expect(result.warnings).toContainEqual(expect.stringContaining("could not determine"));
    expect(result.warnings).toHaveLength(2);
  });
});
