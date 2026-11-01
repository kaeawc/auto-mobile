import { describe, expect, test } from "bun:test";
import { SwipeAtCoordinate } from "../../../src/features/action/SwipeAtCoordinate";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import type {
  PointerEnvironment,
  PointerRequest,
} from "../../../src/features/action/pointer/PointerInjector";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakePointerInjector } from "../../fakes/FakePointerInjector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { observation } from "../../helpers/tapAtCoordinate";

const android = { name: "a", platform: "android", deviceId: "emulator-5554" } as BootedDevice;
const environment = (capabilities: string[]): PointerEnvironment => ({
  platform: "android",
  apiLevel: 34,
  capabilities: new Set(capabilities),
});

function tapAt(route: FakePointerInjector, capabilities: string[]) {
  const adb = new FakeAdbExecutor();
  adb.setAndroidApiLevel(34);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapAtCoordinate(android, adb, {
    timer,
    stylus: { injectors: [route], readEnvironment: async () => environment(capabilities) },
  });
  tap.window = new FakeWindow();
  tap.observeScreen = observeScreen();
  return { tap, adb };
}

function observeScreen() {
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation(100, 200));
  return observe;
}

describe("tapAt with an eraser pointer (#13105)", () => {
  test("an eraser at full pressure takes a pointer route, never adb input stylus", async () => {
    const route = new FakePointerInjector("uinput");
    const { tap, adb } = tapAt(route, []);
    const result = await tap.execute({ x: 4, y: 6, pointer: { toolType: "eraser" } });
    expect(result.success).toBe(true);
    const [request] = route.injected as PointerRequest[];
    expect(request.features.toolType).toBe("eraser");
    expect(adb.getExecutedCommands().some((c) => c.includes("input stylus"))).toBe(false);
  });
});

describe("tapAt with a rich stylus pointer (#13099)", () => {
  test("pressure other than 1 takes the instrumentation route, not adb input stylus", async () => {
    const route = new FakePointerInjector("instrumentation");
    const { tap, adb } = tapAt(route, ["stylus_input_v1"]);
    const result = await tap.execute({
      x: 4,
      y: 6,
      pointer: { toolType: "stylus", pressure: 0.4, tilt: 0.2, buttons: ["primary"] },
    });
    expect(result.success).toBe(true);
    const [request] = route.injected as PointerRequest[];
    expect(request.buttons).toBe(32);
    expect(request.points).toEqual([
      { x: 4, y: 6, pressure: 0.4, tilt: 0.2 },
      { x: 4, y: 6, durationMs: 40, pressure: 0.4, tilt: 0.2 },
    ]);
    expect(adb.getExecutedCommands().some((c) => c.includes("input stylus"))).toBe(false);
  });

  test("a long press holds for its duration", async () => {
    const route = new FakePointerInjector("instrumentation");
    const { tap } = tapAt(route, ["stylus_input_v1"]);
    await tap.execute({
      x: 4,
      y: 6,
      action: "longPress",
      durationMs: 900,
      pointer: { toolType: "stylus", pressure: 0.5 },
    });
    expect((route.injected[0] as PointerRequest).points[1].durationMs).toBe(900);
  });

  test("a runner without the capability is refused before any input and names it", async () => {
    const route = new FakePointerInjector("instrumentation", {
      supported: false,
      reason: "the connected runner does not advertise stylus_input_v1",
      missingCapability: "stylus_input_v1",
    });
    const { tap, adb } = tapAt(route, []);
    const result = await tap.execute({
      x: 4,
      y: 6,
      pointer: { toolType: "stylus", pressure: 0.5 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("stylus_input_v1");
    expect(route.injected).toEqual([]);
    expect(adb.getExecutedCommands().some((c) => c.includes("input"))).toBe(false);
  });

  test("a failure after dispatch is indeterminate: do not retry", async () => {
    const route = new FakePointerInjector("instrumentation");
    route.failure = new Error("adb connection lost");
    const { tap } = tapAt(route, ["stylus_input_v1"]);
    const result = await tap.execute({
      x: 4,
      y: 6,
      pointer: { toolType: "stylus", pressure: 0.5 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Do not retry automatically");
  });

  test("a plain stylus tap still uses adb input stylus", async () => {
    const route = new FakePointerInjector("instrumentation");
    const { tap, adb } = tapAt(route, ["stylus_input_v1"]);
    const result = await tap.execute({ x: 4, y: 6, pointer: { toolType: "stylus" } });
    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toContain("shell input stylus tap 4 6");
    expect(route.asked).toEqual([]);
  });
});

describe("swipeAt with a rich stylus pointer (#13099)", () => {
  function swipe(route: FakePointerInjector, capabilities: string[]) {
    const adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(34);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const swipeAt = new SwipeAtCoordinate(android, adb, {
      timer,
      stylus: { injectors: [route], readEnvironment: async () => environment(capabilities) },
    });
    swipeAt.window = new FakeWindow();
    swipeAt.observeScreen = observeScreen();
    return { swipeAt, adb };
  }
  const gesture = {
    from: { x: 10, y: 10 },
    to: { x: 50, y: 80 },
    durationMs: 300,
  };

  test("a swipe with pressure goes through the instrumentation route as a two-point stroke", async () => {
    const route = new FakePointerInjector("instrumentation");
    const { swipeAt, adb } = swipe(route, ["stylus_input_v1"]);
    const result = await swipeAt.execute({
      ...gesture,
      pointer: { toolType: "stylus", pressure: 0.3 },
    });
    expect(result.success).toBe(true);
    expect((route.injected[0] as PointerRequest).points).toEqual([
      { x: 10, y: 10, pressure: 0.3 },
      { x: 50, y: 80, durationMs: 300, pressure: 0.3 },
    ]);
    expect(adb.getExecutedCommands().some((c) => c.includes("input stylus"))).toBe(false);
  });

  test("a runner without the capability is refused before any input", async () => {
    const route = new FakePointerInjector("instrumentation", {
      supported: false,
      reason: "the connected runner does not advertise stylus_input_v1",
      missingCapability: "stylus_input_v1",
    });
    const { swipeAt } = swipe(route, []);
    const result = await swipeAt.execute({
      ...gesture,
      pointer: { toolType: "stylus", tilt: 0.2 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("stylus_input_v1");
    expect(route.injected).toEqual([]);
  });

  test("a failure after dispatch is reported as indeterminate", async () => {
    const route = new FakePointerInjector("instrumentation");
    route.failure = new Error("adb connection lost");
    const { swipeAt } = swipe(route, ["stylus_input_v1"]);
    const result = await swipeAt.execute({
      ...gesture,
      pointer: { toolType: "stylus", pressure: 0.3 },
    });
    expect(result.success).toBe(false);
    expect(result.outcomeIndeterminate).toBe(true);
  });
});
