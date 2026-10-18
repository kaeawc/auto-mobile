import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  TapAndroidDispatchPhase,
  type AndroidDispatchHost,
} from "../../../src/features/action/tapAndroidDispatchPhase";
import type { Element } from "../../../src/models";

const element = { text: "Go" } as Element;

function setup(talkBack: { success: boolean } = { success: true }) {
  const calls: string[] = [];
  const self: { phase?: TapAndroidDispatchPhase } = {};
  const host = {
    device: { deviceId: "d", platform: "android" },
    timer: new FakeTimer(),
    adb: () => ({}),
    accessibilityService: () => ({}),
    talkBackStrategy: () => ({
      executePreciseTap: async () => {
        calls.push("preciseTap");
        return talkBack;
      },
      executeCoordinateFallback: async (_x: number, _y: number, action: string) => {
        calls.push(`fallback:${action}`);
        return talkBack;
      },
    }),
    talkBackDriverFactory: () => ({ createDriver: () => ({}) }),
    executeAndroidTapWithCoordinates: async (
      ...args: Parameters<TapAndroidDispatchPhase["executeAndroidTapWithCoordinates"]>
    ) => {
      await self.phase?.executeAndroidTapWithCoordinates(...args);
    },
    executeAndroidLongPress: async (
      _x: number,
      _y: number,
      durationMs: number,
      _el: Element,
      _signal: AbortSignal | undefined,
      skipSemantic: boolean,
    ) => {
      calls.push(`longPress:${durationMs}:${skipSemantic}`);
    },
    reportTalkBackActivationWarning: (_r: unknown, _c: unknown, action: string) => {
      calls.push(`report:${action}`);
    },
  } as never as AndroidDispatchHost;
  const phase = new TapAndroidDispatchPhase(host);
  self.phase = phase;
  return { phase, calls };
}

describe("TapAndroidDispatchPhase", () => {
  test("longPress routes to the owner's long-press seam", async () => {
    const { phase, calls } = setup();
    await phase.executeAndroidTapWithCoordinates("longPress", 1, 2, 700, element, undefined, true);
    expect(calls).toEqual(["longPress:700:true"]);
  });

  test("scoped TalkBack tap activates precisely and reports without falling back", async () => {
    const { phase, calls } = setup({ success: true });
    await phase.executeScopedAndroidTap({
      action: "tap",
      x: 1,
      y: 2,
      durationMs: 0,
      element,
      talkBackEnabled: true,
    });
    expect(calls).toEqual(["preciseTap", "report:tap"]);
  });

  test("scoped TalkBack longPress uses the coordinate fallback strategy", async () => {
    const { phase, calls } = setup({ success: true });
    await phase.executeScopedAndroidTap({
      action: "longPress",
      x: 1,
      y: 2,
      durationMs: 600,
      element,
      talkBackEnabled: true,
    });
    expect(calls).toEqual(["fallback:longPress", "report:longPress"]);
  });

  test("scoped TalkBack failure falls back to a coordinate longPress then reports", async () => {
    const { phase, calls } = setup({ success: false });
    await phase.executeScopedAndroidTap({
      action: "longPress",
      x: 1,
      y: 2,
      durationMs: 600,
      element,
      talkBackEnabled: true,
    });
    expect(calls).toEqual(["fallback:longPress", "longPress:600:true", "report:longPress"]);
  });
});
