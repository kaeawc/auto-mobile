import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { clearResolvedHomePackageCache } from "../../../src/features/observe/androidLauncherPackages";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { TapCoordinatesRequest } from "../../../src/utils/interfaces/TapCoordinatesRequest";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import {
  carAppTemplateObservation,
  type CarAppTemplateFixture,
} from "../../helpers/carAppTemplateFixtures";

const device: BootedDevice = { deviceId: "aaos-34", platform: "android", name: "AAOS" };
const FIXTURE_APP = "dev.jasonpearson.automobile.automotivefixture";

/**
 * BACK reaches the device but the template never changes (#16744); only a tap on the host's Back
 * affordance pops the screen, so the fake screen moves to `after` once that tap lands.
 */
function templateDevice(before: ObserveResult, after: ObserveResult, activityName: string) {
  const taps: Array<{ x: number; y: number }> = [];
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  window.configureActiveWindow({ appId: FIXTURE_APP, activityName, layoutSeqSum: 924 });
  const observe = new FakeObserveScreen();
  observe.setObserveResult(() => (taps.length > 0 ? after : before));
  const keyPresses: string[] = [];
  const action = new PressButton(device, new FakeAdbExecutor(), timer, {
    window,
    observeScreen: observe,
    awaitIdle: new FakeAwaitIdle(),
    globalActionClient: {
      requestGlobalAction: async (action) => {
        keyPresses.push(action);
        return { success: true, action, totalTimeMs: 0 };
      },
    },
    templateBackTapClient: {
      requestTapCoordinates: async (request: TapCoordinatesRequest) => {
        taps.push({ x: request.x, y: request.y });
        return { success: true, totalTimeMs: 0 };
      },
    },
  });
  return { action, taps, keyPresses };
}

let timer: FakeTimer;

beforeEach(() => {
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  clearResolvedHomePackageCache();
});

afterEach(() => {
  clearResolvedHomePackageCache();
});

describe("PressButton back on Car App Library templates (#17498)", () => {
  test.each([
    ["pane", "toolbar_nav_icon", { x: 56, y: 124 }],
    ["list", "toolbar_nav_icon", { x: 56, y: 124 }],
    ["grid", "toolbar_nav_icon", { x: 56, y: 124 }],
    ["list-driving", "toolbar_nav_icon", { x: 56, y: 124 }],
    ["navigation-place-list", "primary_header_action", { x: 56, y: 132 }],
  ] as const)("a no-op BACK on %s falls back to %s", async (name, affordance, point) => {
    const before = carAppTemplateObservation(name as CarAppTemplateFixture);
    const after = carAppTemplateObservation("menu", { updatedAt: 2 });
    const { action, taps, keyPresses } = templateDevice(
      before,
      after,
      "androidx.car.app.activity.CarAppActivity",
    );
    const result = await action.execute("back");
    expect(keyPresses).toEqual(["back"]);
    expect(taps).toEqual([point]);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.backFallback).toBe(affordance);
    expect(result.observation).toBe(after);
  });

  test("a root template keeps the no-change failure and taps nothing", async () => {
    const menu = carAppTemplateObservation("menu");
    const { action, taps } = templateDevice(menu, menu, "androidx.car.app.activity.CarAppActivity");
    const result = await action.execute("back");
    expect(result.success).toBe(false);
    expect(result.error).toBe("No visual change observed");
    expect(result.backFallback).toBeUndefined();
    expect(taps).toEqual([]);
  });

  test("a regular activity keeps the no-change failure and taps nothing", async () => {
    const plain: ObserveResult = {
      ...carAppTemplateObservation("pane", { activityName: ".MainActivity" }),
      viewHierarchy: {
        packageName: FIXTURE_APP,
        hierarchy: { node: { "resource-id": `${FIXTURE_APP}:id/root` } },
      },
    };
    const { action, taps } = templateDevice(plain, plain, ".MainActivity");
    const result = await action.execute("back");
    expect(result.success).toBe(false);
    expect(result.error).toBe("No visual change observed");
    expect(result.backFallback).toBeUndefined();
    expect(taps).toEqual([]);
  });
});
