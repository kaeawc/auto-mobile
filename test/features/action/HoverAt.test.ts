import { describe, expect, test } from "bun:test";
import { HoverAt } from "../../../src/features/action/HoverAt";
import { InstrumentationRoute } from "../../../src/features/action/pointer/InstrumentationRoute";
import type {
  PointerEnvironment,
  PointerInjector,
} from "../../../src/features/action/pointer/PointerInjector";
import type { BootedDevice } from "../../../src/models";
import { hoverAtSchema } from "../../../src/server/hoverAtTool";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakePointerInjector } from "../../fakes/FakePointerInjector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { observation } from "../../helpers/tapAtCoordinate";

const android = { name: "a", platform: "android", deviceId: "emulator-5554" } as BootedDevice;
const ios = { name: "i", platform: "ios", deviceId: "ios-1" } as BootedDevice;

const environment = (capabilities: string[] = ["hover_input_v1"]): PointerEnvironment => ({
  platform: "android",
  apiLevel: 34,
  capabilities: new Set(capabilities),
});

function observeWith(result: ReturnType<typeof observation>) {
  const observe = new FakeObserveScreen();
  observe.setObserveResult(result);
  return observe;
}

function create(
  device: BootedDevice,
  injectors: readonly PointerInjector[],
  capabilities?: string[],
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation(100, 200));
  const hover = new HoverAt(device, new FakeAdbExecutor(), {
    timer,
    pointerInjectors: injectors,
    readPointerEnvironment: async () => environment(capabilities),
  });
  hover.window = new FakeWindow();
  hover.observeScreen = observe;
  return hover;
}

describe("HoverAt routing and refusal", () => {
  test("dispatches the resolved path through the route that supports hover", async () => {
    const injected: Parameters<PointerInjector["inject"]>[0][] = [];
    const route = new InstrumentationRoute(async (request) => void injected.push(request));
    const result = await create(android, [route]).execute({
      points: [
        { x: 10, y: 20, distance: 0.5 },
        { x: 30, y: 40, durationMs: 120, distance: 0.1 },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.route).toBe("instrumentation");
    expect(result.plannedDurationMs).toBe(120);
    expect(injected).toHaveLength(1);
    expect(injected[0].features).toEqual({ toolType: "stylus", hover: true });
    expect(injected[0].points).toEqual([
      { x: 10, y: 20, durationMs: undefined, distance: 0.5 },
      { x: 30, y: 40, durationMs: 120, distance: 0.1 },
    ]);
  });

  test("a mouse hover asks the route for a mouse tool type", async () => {
    const fake = new FakePointerInjector("instrumentation");
    await create(android, [fake]).execute({ points: [{ x: 5, y: 5 }], toolType: "mouse" });
    expect(fake.asked).toEqual([{ toolType: "mouse", hover: true }]);
    expect(fake.injected[0].features.toolType).toBe("mouse");
  });

  test("normalized coordinates resolve to native pixels before injection", async () => {
    const fake = new FakePointerInjector("instrumentation");
    await create(android, [fake]).execute({
      points: [{ x: 0.5, y: 0.5 }],
      coordinateSpace: "normalized",
    });
    expect(fake.injected[0].points[0]).toMatchObject({ x: 50, y: 100 });
  });

  test("a runner without hover_input_v1 is refused before any input, naming the capability", async () => {
    const dispatched: string[] = [];
    const route = new InstrumentationRoute(async () => void dispatched.push("sent"));
    const result = await create(android, [route], []).execute({ points: [{ x: 1, y: 1 }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("hover_input_v1");
    expect(result.error).toContain("No input was sent");
    expect(result.error).toContain("never substituted");
    expect(dispatched).toEqual([]);
  });

  test("the default route hovers through am instrument and reports the instrumentation's result", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "am instrument",
      createExecResult(
        "INSTRUMENTATION_RESULT: success=true\nINSTRUMENTATION_RESULT: injected=3\nINSTRUMENTATION_CODE: -1",
        "",
      ),
    );
    const hover = new HoverAt(android, adb, {
      timer: new FakeTimer(),
      readPointerEnvironment: async () => environment(["hover_input_v1"]),
    });
    hover.window = new FakeWindow();
    hover.observeScreen = observeWith(observation(100, 200));
    const result = await hover.execute({ points: [{ x: 1, y: 1 }] });
    expect(result).toMatchObject({ success: true, route: "instrumentation" });
    expect(
      adb
        .getExecutedCommands()
        .some((command) => command.includes("am instrument -w -r --no-restart -e request")),
    ).toBe(true);
  });

  test("iOS is refused before the environment is even read", async () => {
    let read = false;
    const hover = new HoverAt(ios, new FakeAdbExecutor(), {
      readPointerEnvironment: async () => {
        read = true;
        return environment();
      },
    });
    const result = await hover.execute({ points: [{ x: 1, y: 1 }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Android only");
    expect(read).toBe(false);
  });

  test("an out-of-bounds point is refused before dispatch", async () => {
    const fake = new FakePointerInjector("instrumentation");
    const result = await create(android, [fake]).execute({ points: [{ x: 9999, y: 1 }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("points[0]");
    expect(fake.injected).toEqual([]);
  });

  test("a failing route reports a partially run hover, not a success", async () => {
    const fake = new FakePointerInjector("instrumentation");
    fake.failure = new Error("injection died");
    const result = await create(android, [fake]).execute({ points: [{ x: 1, y: 1 }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("injection died");
    expect(result.error).toContain("verify state");
  });

  test("a path too long for the limit is refused before dispatch", async () => {
    const fake = new FakePointerInjector("instrumentation");
    const points = Array.from({ length: 6 }, (_, i) => ({ x: i, y: i, durationMs: 5000 }));
    await expect(create(android, [fake]).execute({ points })).rejects.toThrow(/exceeds/);
    expect(fake.injected).toEqual([]);
  });
});

describe("hoverAtSchema", () => {
  const parse = (value: unknown) => hoverAtSchema.safeParse(value);
  test("accepts the dragPath point shape with an optional distance", () => {
    expect(parse({ points: [{ x: 1, y: 2 }] }).success).toBe(true);
    expect(
      parse({
        points: [
          { x: 1, y: 2, distance: 0.2 },
          { x: 3, y: 4, durationMs: 100 },
        ],
        toolType: "stylus",
        coordinateSpace: "absolute",
        display: "active",
        snapshotId: "s",
      }).success,
    ).toBe(true);
  });
  test("rejects empty paths, unknown fields, bad tool types and a mouse distance", () => {
    expect(parse({ points: [] }).success).toBe(false);
    expect(parse({ points: [{ x: 1, y: 2, pressure: 1 }] }).success).toBe(false);
    expect(parse({ points: [{ x: 1, y: 2 }], toolType: "finger" }).success).toBe(false);
    expect(parse({ points: [{ x: 1, y: 2, distance: 2 }] }).success).toBe(false);
    expect(parse({ points: [{ x: 1, y: 2, distance: 0.5 }], toolType: "mouse" }).success).toBe(
      false,
    );
    expect(parse({ points: [{ x: 2, y: 0.5 }], coordinateSpace: "normalized" }).success).toBe(
      false,
    );
  });
});
