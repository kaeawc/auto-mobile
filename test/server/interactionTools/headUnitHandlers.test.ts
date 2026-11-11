import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HeadUnitInteraction,
  type HeadUnitIdleTiming,
} from "../../../src/features/androidAuto/HeadUnitInteraction";
import type { BootedDevice } from "../../../src/models";
import type { CarAppProjectedTemplates } from "../../../src/models/CarAppTemplates";
import {
  registerInteractionTools,
  type InteractionToolDependencies,
} from "../../../src/server/interactionTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { defaultHeadUnitInteractionFactory } from "../../../src/server/interactionTools/headUnitHandlers";
import type { PressButtonArgs, TapAtArgs } from "../../../src/server/interactionToolTypes";
import { FakeSession } from "../../fakes/FakeAndroidAutoProjection";
import { FakeTimer } from "../../fakes/FakeTimer";
import { fixtureProjectedTemplates } from "../../helpers/androidAutoProjectionFixtures";
import { toolJson, toolText } from "../../helpers/toolResponse";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

/** Registered once: the tools read their collaborators from this object on every call. */
const deps: InteractionToolDependencies = {};

beforeAll(() => {
  registerInteractionTools(deps);
});

afterAll(() => {
  ToolRegistry.clearTools();
});

/** Calls the registered tool, which is where display "headUnit" is routed. */
function callTool(
  name: "tapAt" | "pressButton",
  device: BootedDevice,
  args: Partial<TapAtArgs> | Partial<PressButtonArgs>,
) {
  const handler = ToolRegistry.getTool(name)?.deviceAwareHandler;
  if (!handler) {
    throw new Error(`${name} is not registered`);
  }
  return handler(device, args);
}

const phone: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const TIMING: HeadUnitIdleTiming = { pollMs: 250, unchangedSettleMs: 1_000, timeoutMs: 3_000 };

/** A head unit showing `before` that shows `after` once any console command arrives. */
function headUnit(before: CarAppProjectedTemplates, after: CarAppProjectedTemplates) {
  const session = new FakeSession();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let current = before;
  const interaction = new HeadUnitInteraction(
    {
      sendCommand: (command) => {
        session.sendCommand(command);
        current = after;
      },
      isRunning: () => session.isRunning(),
    },
    { read: async () => current },
    timer,
    TIMING,
  );
  const phonePathCalls: string[] = [];
  Object.assign(deps, {
    headUnitInteractionFactory: () => interaction,
    tapAtElementFactory: () => ({
      execute: async () => {
        phonePathCalls.push("tapAt");
        throw new Error("phone tapAt must not run");
      },
    }),
    pressButtonFactory: () => ({
      execute: async () => {
        phonePathCalls.push("pressButton");
        throw new Error("phone pressButton must not run");
      },
    }),
  } satisfies InteractionToolDependencies);
  return { session, phonePathCalls };
}

const MENU = fixtureProjectedTemplates(1);
const LIST = fixtureProjectedTemplates(2);

describe('tapAt and pressButton with display "headUnit"', () => {
  test("tapAt sends a DHU tap and reports the push to ListScreen", async () => {
    const { session, phonePathCalls } = headUnit(MENU, LIST);
    const args = { x: 640, y: 200, display: "headUnit" } as TapAtArgs;
    const response = await callTool("tapAt", phone, args);
    expect(session.commands).toEqual(["tap 640 200"]);
    expect(phonePathCalls).toEqual([]);
    expect(toolText(response)).toContain("screen changed (ListScreen on top)");
    const payload = toolJson(response);
    expect(payload.success).toBe(true);
    expect(payload.headUnit).toMatchObject({
      display: "headUnit",
      commands: ["tap 640 200"],
      effect: { screenChanged: true, basis: "carAppTemplates changed" },
    });
  });

  test("pressButton back sends dpad back and reports the pop", async () => {
    const { session, phonePathCalls } = headUnit(LIST, MENU);
    const args = { button: "back", display: "headUnit" } as PressButtonArgs;
    const response = await callTool("pressButton", phone, args);
    expect(session.commands).toEqual(["dpad back"]);
    expect(phonePathCalls).toEqual([]);
    expect(toolText(response)).toContain("Pressed back on the head unit; screen changed");
  });

  test("a no-op tap reads as unchanged", async () => {
    headUnit(MENU, MENU);
    const args = { x: 5, y: 5, display: "headUnit" } as TapAtArgs;
    const response = await callTool("tapAt", phone, args);
    expect(toolText(response)).toContain("screen unchanged");
  });

  test("phone-only tapAt fields are refused before any input", async () => {
    const { session } = headUnit(MENU, LIST);
    const args = {
      x: 0.5,
      y: 0.5,
      coordinateSpace: "normalized",
      action: "longPress",
      display: "headUnit",
    } as TapAtArgs;
    await expect(callTool("tapAt", phone, args)).rejects.toThrow(
      "coordinateSpace, action are not supported",
    );
    expect(session.commands).toEqual([]);
  });

  test("a non-Android device is refused", async () => {
    headUnit(MENU, LIST);
    const ios: BootedDevice = { deviceId: "sim", platform: "ios", name: "iPhone" };
    const args = { button: "back", display: "headUnit" } as PressButtonArgs;
    await expect(callTool("pressButton", ios, args)).rejects.toThrow("not ios");
  });

  test("without a display, or with a phone panel, the phone path runs as before", async () => {
    const { session, phonePathCalls } = headUnit(MENU, LIST);
    await expect(callTool("tapAt", phone, { x: 1, y: 1 })).rejects.toThrow(
      "phone tapAt must not run",
    );
    await expect(
      callTool("pressButton", phone, { button: "back", display: "1" } as PressButtonArgs),
    ).rejects.toThrow("phone pressButton must not run");
    expect(phonePathCalls).toEqual(["tapAt", "pressButton"]);
    expect(session.commands).toEqual([]);
  });

  test("the default factory refuses a device this daemon runs no DHU for, and starts none", () => {
    expect(() => defaultHeadUnitInteractionFactory(phone)).toThrow(
      "No Desktop Head Unit is running for emulator-5554",
    );
  });
});
