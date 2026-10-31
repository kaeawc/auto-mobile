import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import {
  pointerNeedsInstrumentation,
  stylusButtonMask,
} from "../../../../src/models/PointerOption";
import type { PointerEnvironment } from "../../../../src/features/action/pointer/PointerInjector";
import {
  RICH_TAP_DURATION_MS,
  dispatchRichStylus,
  strokeRequest,
  tapStrokePoints,
} from "../../../../src/features/action/pointer/richStylus";
import { StylusOutcomeIndeterminateError } from "../../../../src/features/action/stylusPointer";
import { PointerNotSentError } from "../../../../src/features/action/pointer/instrumentationDispatch";
import { FakePointerInjector } from "../../../fakes/FakePointerInjector";
import { pointerSchema } from "../../../../src/server/pointerSchema";
import type { BootedDevice } from "../../../../src/models";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";

const device = { name: "a", platform: "android", deviceId: "emulator-5554" } as BootedDevice;
const environment = (caps: string[], apiLevel = 34): PointerEnvironment => ({
  platform: "android",
  apiLevel,
  capabilities: new Set(caps),
});

describe("PointerOption helpers", () => {
  test("only more than plain full-pressure stylus needs the instrumentation route", () => {
    expect(pointerNeedsInstrumentation(undefined)).toBe(false);
    expect(pointerNeedsInstrumentation({ toolType: "stylus" })).toBe(false);
    expect(pointerNeedsInstrumentation({ toolType: "stylus", pressure: 1 })).toBe(false);
    for (const extra of [
      { pressure: 0.5 },
      { pressure: 0 },
      { tilt: 0.3 },
      { orientation: -1 },
      { buttons: ["primary" as const] },
    ]) {
      expect(pointerNeedsInstrumentation({ toolType: "stylus", ...extra })).toBe(true);
    }
  });

  test("button names map to the MotionEvent state mask", () => {
    expect(stylusButtonMask(undefined)).toBe(0);
    expect(stylusButtonMask(["primary"])).toBe(32);
    expect(stylusButtonMask(["secondary"])).toBe(64);
    expect(stylusButtonMask(["primary", "secondary"])).toBe(96);
  });

  test("the pointer schema takes tilt, orientation and buttons within range", () => {
    expect(
      pointerSchema.safeParse({
        toolType: "stylus",
        pressure: 0.4,
        tilt: 0.5,
        orientation: -1,
        buttons: ["primary"],
      }).success,
    ).toBe(true);
    for (const bad of [
      { tilt: 2 },
      { tilt: -0.1 },
      { orientation: 4 },
      { buttons: [] },
      { buttons: ["primary", "primary"] },
      { buttons: ["tertiary"] },
      { pressure: 1.1 },
      { toolType: "finger" },
    ]) {
      expect(pointerSchema.safeParse({ toolType: "stylus", ...bad }).success).toBe(false);
    }
  });
});

describe("eraser pointer (#13105)", () => {
  test("the schema takes an eraser with pressure", () => {
    expect(pointerSchema.safeParse({ toolType: "eraser", pressure: 0.5 }).success).toBe(true);
  });

  test("an eraser always needs a pointer route, even at full pressure", () => {
    expect(pointerNeedsInstrumentation({ toolType: "eraser" })).toBe(true);
    expect(pointerNeedsInstrumentation({ toolType: "stylus" })).toBe(false);
  });

  test("an eraser stroke asks the routes for an eraser", () => {
    const request = strokeRequest({ toolType: "eraser" }, [
      { x: 1, y: 2 },
      { x: 3, y: 4, durationMs: 100 },
    ]);
    expect(request.features.toolType).toBe("eraser");
  });
});

describe("strokeRequest", () => {
  test("fills the pointer's constant axes into points that give no value of their own", () => {
    const request = strokeRequest(
      { toolType: "stylus", pressure: 0.5, tilt: 0.2, buttons: ["primary"] },
      [
        { x: 1, y: 2 },
        { x: 3, y: 4, durationMs: 100, pressure: 0.9 },
      ],
    );
    expect(request.buttons).toBe(32);
    expect(request.points).toEqual([
      { x: 1, y: 2, pressure: 0.5, tilt: 0.2 },
      { x: 3, y: 4, durationMs: 100, pressure: 0.9, tilt: 0.2 },
    ]);
    expect(request.features).toEqual({
      toolType: "stylus",
      variablePressure: true,
      extendedAxes: true,
    });
  });

  test("the features describe what the request needs, so a refusal names the real reason", () => {
    const needs = (pointer: Parameters<typeof strokeRequest>[0], path = false) =>
      strokeRequest(pointer, [{ x: 1, y: 1 }], { path }).features;
    expect(needs({ toolType: "stylus", pressure: 0.5 })).toEqual({
      toolType: "stylus",
      variablePressure: true,
    });
    expect(needs({ toolType: "stylus", tilt: 0.3 })).toEqual({
      toolType: "stylus",
      extendedAxes: true,
    });
    expect(needs({ toolType: "stylus" }, true)).toEqual({ toolType: "stylus", path: true });
    expect(needs({ toolType: "stylus", buttons: ["secondary"] }).extendedAxes).toBe(true);
  });

  test("a tap is a down and up at one point, a long press holds for its duration", () => {
    expect(tapStrokePoints({ x: 5, y: 6 }, undefined)).toEqual([
      { x: 5, y: 6 },
      { x: 5, y: 6, durationMs: RICH_TAP_DURATION_MS },
    ]);
    expect(tapStrokePoints({ x: 5, y: 6 }, 800)[1].durationMs).toBe(800);
  });
});

describe("dispatchRichStylus", () => {
  const request = strokeRequest(
    { toolType: "stylus", pressure: 0.5 },
    tapStrokePoints({ x: 1, y: 1 }, undefined),
  );

  test("injects through the route the device supports, after the fence and dispatch hooks", async () => {
    const calls: string[] = [];
    const route = new FakePointerInjector("instrumentation");
    await dispatchRichStylus(device, new FakeAdbExecutor(), request, {
      readEnvironment: async () => environment(["stylus_input_v1"]),
      injectors: [route],
      assertCurrent: () => void calls.push("fence"),
      onDispatch: () => void calls.push("dispatch"),
    });
    expect(calls).toEqual(["fence", "dispatch"]);
    expect(route.injected).toEqual([request]);
  });

  test("a device without the capability is refused before the fence, the hooks and any injection", async () => {
    const calls: string[] = [];
    const real = new FakePointerInjector("instrumentation", (features, env) =>
      env.capabilities.has("stylus_input_v1")
        ? { supported: true }
        : {
            supported: false,
            reason: "the runner does not advertise stylus_input_v1",
            missingCapability: "stylus_input_v1",
          },
    );
    const error = await dispatchRichStylus(device, new FakeAdbExecutor(), request, {
      readEnvironment: async () => environment([]),
      injectors: [real],
      assertCurrent: () => void calls.push("fence"),
      onDispatch: () => void calls.push("dispatch"),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("stylus_input_v1");
    expect((error as Error).message).toContain("never substituted");
    expect(calls).toEqual([]);
    expect(real.injected).toEqual([]);
  });

  test("a failure after dispatch is indeterminate; one the route says was never sent is not", async () => {
    const sent = new FakePointerInjector("instrumentation");
    sent.failure = new Error("adb connection lost");
    const afterDispatch = await dispatchRichStylus(device, new FakeAdbExecutor(), request, {
      readEnvironment: async () => environment(["stylus_input_v1"]),
      injectors: [sent],
    }).catch((thrown: unknown) => thrown);
    expect(afterDispatch).toBeInstanceOf(StylusOutcomeIndeterminateError);

    const notSent = new FakePointerInjector("instrumentation");
    notSent.failure = new PointerNotSentError(
      "CtrlProxy has no pointer instrumentation. No input was sent.",
    );
    const refused = await dispatchRichStylus(device, new FakeAdbExecutor(), request, {
      readEnvironment: async () => environment(["stylus_input_v1"]),
      injectors: [notSent],
    }).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(PointerNotSentError);
  });

  test("the default routes use am instrument with --no-restart", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "am instrument",
      createExecResult("INSTRUMENTATION_RESULT: success=true", ""),
    );
    await dispatchRichStylus(device, adb, request, {
      readEnvironment: async () => environment(["stylus_input_v1"]),
    });
    expect(adb.getExecutedCommands()[0]).toContain("am instrument -w -r --no-restart -e request");
  });
});
