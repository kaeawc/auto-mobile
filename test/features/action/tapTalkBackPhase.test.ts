import { describe, expect, test } from "bun:test";
import {
  TapTalkBackPhase,
  type TapTalkBackHost,
} from "../../../src/features/action/tapTalkBackPhase";
import type { Element } from "../../../src/models";

const element = { bounds: { left: 0, top: 0, right: 10, bottom: 10 } } as Element;

function build(strategy: object, screenReaderNavigation = false) {
  const coordinateCalls: unknown[][] = [];
  const host = {
    device: { deviceId: "d1", platform: "android" },
    talkBackStrategy: () => strategy,
    talkBackDriverFactory: () => ({ createDriver: () => ({}) }),
    getElementCenter: () => ({ x: 5, y: 5 }),
    isScreenReaderNavigationEnabled: () => screenReaderNavigation,
    executeAndroidTapWithCoordinates: async (...args: unknown[]) => {
      coordinateCalls.push(args);
    },
    reportTalkBackActivationWarning: () => {},
  } as never as TapTalkBackHost;
  return { phase: new TapTalkBackPhase(host), coordinateCalls };
}

describe("TapTalkBackPhase.executeAndroidTapWithAccessibility", () => {
  test("direct activation success skips the coordinate fallback", async () => {
    const { phase, coordinateCalls } = build({
      executeDirectActivation: async () => ({ success: true }),
    });
    const result = await phase.executeAndroidTapWithAccessibility("tap", 1, 2, element, 0);
    expect(result).toBeUndefined();
    expect(coordinateCalls).toHaveLength(0);
  });

  test("a semantic long press failure throws instead of falling back", async () => {
    const { phase, coordinateCalls } = build({
      executeLongPress: async () => ({ success: false, semanticActionFailure: true, error: "x" }),
    });
    await expect(
      phase.executeAndroidTapWithAccessibility("longPress", 1, 2, element, 500),
    ).rejects.toThrow("Semantic long press failed");
    expect(coordinateCalls).toHaveLength(0);
  });

  test("a failed precise tap falls back to the ADB coordinate tap", async () => {
    const { phase, coordinateCalls } = build({
      executeDirectActivation: async () => ({ success: false, error: "no" }),
      executePreciseTap: async () => ({ success: false, error: "gesture" }),
    });
    await phase.executeAndroidTapWithAccessibility("tap", 1, 2, element, 0);
    expect(coordinateCalls).toHaveLength(1);
    expect(coordinateCalls[0]?.slice(0, 3)).toEqual(["tap", 1, 2]);
  });
});
