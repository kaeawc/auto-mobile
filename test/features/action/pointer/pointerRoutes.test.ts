import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import {
  invalidPointerFeatures,
  type PointerEnvironment,
  type PointerRequest,
} from "../../../../src/features/action/pointer/PointerInjector";
import { AdbInputSourceRoute } from "../../../../src/features/action/pointer/AdbInputSourceRoute";
import { CtrlProxyA11yRoute } from "../../../../src/features/action/pointer/CtrlProxyA11yRoute";
import { InstrumentationRoute } from "../../../../src/features/action/pointer/InstrumentationRoute";
import { defaultPointerRoutes } from "../../../../src/features/action/pointer/pointerRoutes";
import {
  derivePointerInput,
  pointerCapabilities,
  requirePointerRoute,
  selectPointerRoute,
} from "../../../../src/features/action/pointer/selectPointerRoute";
import { FakePointerInjector } from "../../../fakes/FakePointerInjector";

const env = (over: Partial<PointerEnvironment> & { caps?: string[] } = {}): PointerEnvironment => ({
  platform: "android",
  apiLevel: 34,
  capabilities: new Set(over.caps ?? []),
  ...over,
});
const noop = async () => {};
const routes = (dispatches = { a11y: noop, adbInputSource: noop, instrumentation: noop }) =>
  defaultPointerRoutes(dispatches);
const tap: PointerRequest = { features: { toolType: "finger" }, points: [{ x: 1, y: 2 }] };

describe("route support", () => {
  test("the accessibility route takes a plain finger touch and nothing else", () => {
    const route = new CtrlProxyA11yRoute(noop);
    expect(route.supports({ toolType: "finger" }, env())).toEqual({ supported: true });
    for (const features of [
      { toolType: "stylus" as const },
      { toolType: "mouse" as const },
      { toolType: "finger" as const, hover: true },
      { toolType: "finger" as const, variablePressure: true },
    ]) {
      expect(route.supports(features, env()).supported).toBe(false);
    }
    expect(route.supports({ toolType: "finger" }, env({ platform: "ios" })).supported).toBe(false);
  });

  test("adb input stylus: a constant-pressure stylus stroke on API 31 and newer only", () => {
    const route = new AdbInputSourceRoute(noop);
    expect(route.supports({ toolType: "stylus" }, env({ apiLevel: 31 }))).toEqual({
      supported: true,
    });
    expect(route.supports({ toolType: "stylus" }, env({ apiLevel: 30 })).supported).toBe(false);
    expect(route.supports({ toolType: "stylus" }, env({ apiLevel: undefined })).supported).toBe(
      false,
    );
    expect(route.supports({ toolType: "stylus", variablePressure: true }, env()).supported).toBe(
      false,
    );
    expect(route.supports({ toolType: "stylus", hover: true }, env()).supported).toBe(false);
    expect(route.supports({ toolType: "mouse" }, env()).supported).toBe(false);
    expect(route.supports({ toolType: "finger" }, env()).supported).toBe(false);
  });

  test("instrumentation needs the matching capability flag and names it when absent", () => {
    const route = new InstrumentationRoute(noop);
    expect(route.supports({ toolType: "stylus" }, env({ caps: ["stylus_input_v1"] }))).toEqual({
      supported: true,
    });
    expect(route.supports({ toolType: "stylus" }, env())).toMatchObject({
      supported: false,
      missingCapability: "stylus_input_v1",
    });
    expect(
      route.supports(
        { toolType: "stylus", variablePressure: true },
        env({ caps: ["stylus_input_v1"] }),
      ),
    ).toEqual({ supported: true });
    for (const toolType of ["stylus", "mouse"] as const) {
      expect(route.supports({ toolType, hover: true }, env({ caps: ["hover_input_v1"] }))).toEqual({
        supported: true,
      });
      expect(
        route.supports({ toolType, hover: true }, env({ caps: ["stylus_input_v1"] })),
      ).toMatchObject({ supported: false, missingCapability: "hover_input_v1" });
    }
    expect(
      route.supports({ toolType: "finger" }, env({ caps: ["stylus_input_v1"] })).supported,
    ).toBe(false);
    expect(
      route.supports({ toolType: "stylus" }, env({ platform: "ios", caps: ["stylus_input_v1"] }))
        .supported,
    ).toBe(false);
  });

  test("no route takes anything on iOS", () => {
    const ios = env({ platform: "ios", caps: ["stylus_input_v1", "hover_input_v1"] });
    for (const features of [
      { toolType: "finger" as const },
      { toolType: "stylus" as const },
      { toolType: "stylus" as const, hover: true },
    ]) {
      expect(routes().every((route) => !route.supports(features, ios).supported)).toBe(true);
    }
  });
});

describe("invalidPointerFeatures", () => {
  test("rejects contradictory requests regardless of capabilities", () => {
    for (const features of [
      { toolType: "finger" as const, hover: true },
      { toolType: "finger" as const, variablePressure: true },
      { toolType: "stylus" as const, hover: true, variablePressure: true },
      { toolType: "mouse" as const, hover: true, variablePressure: true },
      { toolType: "mouse" as const },
      { toolType: "mouse" as const, path: true },
      { toolType: "stylus" as const, hover: true, extendedAxes: true },
      { toolType: "stylus" as const, hover: true, path: true },
    ]) {
      expect(invalidPointerFeatures(features)).toBeString();
    }
    for (const features of [
      { toolType: "finger" as const },
      { toolType: "stylus" as const },
      { toolType: "stylus" as const, variablePressure: true },
      { toolType: "stylus" as const, hover: true },
      { toolType: "mouse" as const, hover: true },
    ]) {
      expect(invalidPointerFeatures(features)).toBeUndefined();
    }
  });
});

describe("selectPointerRoute", () => {
  test("a finger touch keeps the accessibility route even when richer routes exist", () => {
    const choice = selectPointerRoute(
      { toolType: "finger" },
      env({ caps: ["stylus_input_v1", "hover_input_v1"] }),
      routes(),
    );
    expect(choice.selected?.route).toBe("ctrlproxy-a11y");
  });

  test("a stylus request moves off the accessibility path", () => {
    expect(selectPointerRoute({ toolType: "stylus" }, env(), routes()).selected?.route).toBe(
      "adb-input-source",
    );
    expect(
      selectPointerRoute(
        { toolType: "stylus", variablePressure: true },
        env({ caps: ["stylus_input_v1"] }),
        routes(),
      ).selected?.route,
    ).toBe("instrumentation");
  });

  test("an older APK without the capability is refused before dispatch, never downgraded", () => {
    const sent: string[] = [];
    const injectors = routes({
      a11y: async () => void sent.push("a11y"),
      adbInputSource: async () => void sent.push("adb"),
      instrumentation: async () => void sent.push("instr"),
    });
    const choice = selectPointerRoute({ toolType: "stylus", hover: true }, env(), injectors);
    expect(choice.selected).toBeNull();
    if (choice.selected === null) {
      expect(choice.missingCapabilities).toEqual(["hover_input_v1"]);
      expect(choice.refusal).toContain("a finger touch is never substituted");
      expect(choice.refusal).toContain("hover_input_v1");
      expect(choice.refusal).toContain("ctrlproxy-a11y");
    }
    expect(sent).toEqual([]);
    expect(() =>
      requirePointerRoute({ toolType: "stylus", hover: true }, env(), injectors),
    ).toThrow(ActionableError);
  });

  test("the first supporting injector wins and later ones are not consulted", () => {
    const first = new FakePointerInjector("uinput");
    const second = new FakePointerInjector("emulator-grpc");
    const choice = selectPointerRoute({ toolType: "stylus" }, env(), [first, second]);
    expect(choice.selected).toBe(first);
    expect(second.asked).toEqual([]);
  });

  test("injecting through the chosen route reaches only that route's dispatch", async () => {
    const calls: string[] = [];
    const injectors = routes({
      a11y: async () => void calls.push("a11y"),
      adbInputSource: async () => void calls.push("adb"),
      instrumentation: async () => void calls.push("instr"),
    });
    await requirePointerRoute({ toolType: "finger" }, env(), injectors).inject(tap);
    await requirePointerRoute({ toolType: "stylus" }, env(), injectors).inject({
      ...tap,
      features: { toolType: "stylus" },
    });
    expect(calls).toEqual(["a11y", "adb"]);
  });
});

describe("refusals", () => {
  test("a contradictory request is refused as invalid, not blamed on a missing capability", () => {
    for (const features of [
      { toolType: "stylus" as const, hover: true, variablePressure: true },
      { toolType: "finger" as const, hover: true },
      { toolType: "mouse" as const },
    ]) {
      const choice = selectPointerRoute(features, env({ caps: [] }), routes());
      expect(choice.selected).toBeNull();
      if (choice.selected === null) {
        expect(choice.missingCapabilities).toEqual([]);
        expect(choice.refusal).toContain("not a valid pointer request");
      }
    }
  });

  test("an old device with no flags gets every reason and the missing capability", () => {
    const choice = selectPointerRoute({ toolType: "stylus" }, env({ apiLevel: 29 }), routes());
    expect(choice.selected).toBeNull();
    if (choice.selected === null) {
      expect(choice.missingCapabilities).toEqual(["stylus_input_v1"]);
      expect(choice.refusal).toBe(
        "stylus input cannot be injected on this device, and a finger touch is never substituted. " +
          "ctrlproxy-a11y: accessibility dispatchGesture only produces a finger touch, not stylus; " +
          "adb-input-source: adb input stylus needs Android API 31 or newer (this device reports API 29); " +
          "instrumentation: the connected runner does not advertise stylus_input_v1: this device runs Android API 29 and the route needs Android 13 (API 33). " +
          "Use a device whose runner advertises stylus_input_v1.",
      );
    }
  });

  test("a refused request never reaches any route's inject", async () => {
    const fakes = [new FakePointerInjector("ctrlproxy-a11y", { supported: false, reason: "no" })];
    expect(() => requirePointerRoute({ toolType: "stylus" }, env(), fakes)).toThrow(
      ActionableError,
    );
    expect(fakes[0].injected).toEqual([]);
  });

  test("an aborted signal stops the fake before it records", async () => {
    const fake = new FakePointerInjector("instrumentation");
    const controller = new AbortController();
    controller.abort();
    await expect(fake.inject(tap, controller.signal)).rejects.toThrow();
    expect(fake.injected).toEqual([]);
  });
});

describe("derivePointerInput", () => {
  test("is derived from the same route support, so it cannot disagree with dispatch", () => {
    expect(derivePointerInput(env({ apiLevel: 34 }), routes())).toEqual({
      stylus: true,
      pressure: false,
      hover: false,
      stylusRoute: "adb-input-source",
      pressureRoute: null,
      hoverRoute: null,
    });
    expect(
      derivePointerInput(env({ caps: ["stylus_input_v1", "hover_input_v1"] }), routes()),
    ).toEqual({
      stylus: true,
      pressure: true,
      hover: true,
      stylusRoute: "adb-input-source",
      pressureRoute: "instrumentation",
      hoverRoute: "instrumentation",
    });
    expect(derivePointerInput(env({ apiLevel: 29 }), routes())).toMatchObject({
      stylus: false,
      stylusRoute: null,
    });
    expect(derivePointerInput(env({ platform: "ios" }), routes()).stylus).toBe(false);
  });

  test("pointerCapabilities keeps only the pointer flags", () => {
    const advertised = new Set(["stylus_input_v1", "multi_finger_gesture_v1"]);
    expect([...pointerCapabilities((name) => advertised.has(name))]).toEqual(["stylus_input_v1"]);
  });
});
