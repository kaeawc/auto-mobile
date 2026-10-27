import { describe, expect, test } from "bun:test";
import { DragPath } from "../../../src/features/action/DragPath";
import type {
  PointerEnvironment,
  PointerRequest,
} from "../../../src/features/action/pointer/PointerInjector";
import type { BootedDevice } from "../../../src/models";
import { dragPathSchema } from "../../../src/server/dragPathTool";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakePointerInjector } from "../../fakes/FakePointerInjector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { observation } from "../../helpers/tapAtCoordinate";

const android = { name: "a", platform: "android", deviceId: "emulator-5554" } as BootedDevice;
const ios = { name: "i", platform: "ios", deviceId: "ios-1" } as BootedDevice;
const environment = (capabilities: string[]): PointerEnvironment => ({
  platform: "android",
  apiLevel: 34,
  capabilities: new Set(capabilities),
});
const stylus = { toolType: "stylus" as const };

function create(device: BootedDevice, route: FakePointerInjector, capabilities: string[]) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation(100, 200));
  const dragPath = new DragPath(device, new FakeAdbExecutor(), {
    timer,
    stylus: { injectors: [route], readEnvironment: async () => environment(capabilities) },
  });
  dragPath.window = new FakeWindow();
  dragPath.observeScreen = observe;
  return dragPath;
}

describe("dragPath with a stylus pointer (#13099)", () => {
  test("injects the polyline with per-point pressure and tilt and the holds as repeats", async () => {
    const route = new FakePointerInjector("instrumentation");
    const result = await create(android, route, ["stylus_input_v1"]).execute({
      points: [
        { x: 10, y: 10, pressure: 0.2, tilt: 0.1 },
        { x: 50, y: 60, durationMs: 300, pressure: 1 },
      ],
      holdMs: 100,
      releaseHoldMs: 50,
      pointer: { ...stylus, buttons: ["primary"] },
    });
    expect(result.success).toBe(true);
    expect(result.plannedDurationMs).toBe(450);
    const [request] = route.injected as PointerRequest[];
    expect(request.buttons).toBe(32);
    expect(request.points).toEqual([
      { x: 10, y: 10, pressure: 0.2, tilt: 0.1 },
      { x: 10, y: 10, durationMs: 100, pressure: 0.2, tilt: 0.1 },
      { x: 50, y: 60, durationMs: 300, pressure: 1 },
      { x: 50, y: 60, durationMs: 50, pressure: 1 },
    ]);
  });

  test("a device without stylus_input_v1 is refused before any injection, never a finger drag", async () => {
    const route = new FakePointerInjector("instrumentation", {
      supported: false,
      reason: "the connected runner does not advertise stylus_input_v1",
      missingCapability: "stylus_input_v1",
    });
    const result = await create(android, route, []).execute({
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      pointer: stylus,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("stylus_input_v1");
    expect(route.injected).toEqual([]);
  });

  test("a route failure is reported, not thrown", async () => {
    const route = new FakePointerInjector("instrumentation");
    route.failure = new Error("injection died");
    const result = await create(android, route, ["stylus_input_v1"]).execute({
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      pointer: stylus,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("injection died");
  });

  test("the request carries the path flag, so a refusal does not blame pressure", async () => {
    const route = new FakePointerInjector("instrumentation");
    await create(android, route, ["stylus_input_v1"]).execute({
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      pointer: stylus,
    });
    expect((route.injected[0] as PointerRequest).features).toEqual({
      toolType: "stylus",
      path: true,
    });
  });

  test("a panel selection is refused before any observation or injection", async () => {
    const route = new FakePointerInjector("instrumentation");
    const drag = create(android, route, ["stylus_input_v1"]);
    const result = await drag.execute({
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      pointer: stylus,
      display: "cover",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("default display only");
    expect(route.asked).toEqual([]);
  });

  test("a path that cannot fit the request budget with the instrumentation overhead is refused", async () => {
    const route = new FakePointerInjector("instrumentation");
    const drag = create(android, route, ["stylus_input_v1"]);
    await expect(
      drag.execute(
        {
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 20, durationMs: 4000 },
          ],
          pointer: stylus,
        },
        { deadlineMs: 10_000 },
      ),
    ).rejects.toThrow(/does not fit the remaining request budget/);
    expect(route.injected).toEqual([]);
  });

  test("iOS is refused as Android-only", async () => {
    const route = new FakePointerInjector("instrumentation");
    const result = await create(ios, route, []).execute({
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      pointer: stylus,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Android-only");
    expect(route.injected).toEqual([]);
  });
});

describe("dragPathSchema pointer fields", () => {
  const points = (extra: object) => [
    { x: 1, y: 2, ...extra },
    { x: 3, y: 4 },
  ];
  test("per-point pressure and tilt need a pointer", () => {
    expect(dragPathSchema.safeParse({ points: points({ pressure: 0.5 }) }).success).toBe(false);
    expect(dragPathSchema.safeParse({ points: points({ tilt: 0.5 }) }).success).toBe(false);
    expect(
      dragPathSchema.safeParse({ points: points({ pressure: 0.5, tilt: 0.5 }), pointer: stylus })
        .success,
    ).toBe(true);
  });
  test("ranges are enforced and a plain finger drag is unchanged", () => {
    expect(dragPathSchema.safeParse({ points: points({}) }).success).toBe(true);
    expect(
      dragPathSchema.safeParse({ points: points({ pressure: 2 }), pointer: stylus }).success,
    ).toBe(false);
    expect(dragPathSchema.safeParse({ points: points({ tilt: 3 }), pointer: stylus }).success).toBe(
      false,
    );
  });
});
