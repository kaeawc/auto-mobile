import { describe, expect, test } from "bun:test";
import type { PointerEnvironment } from "../../../../src/features/action/pointer/PointerInjector";
import { UinputRoute } from "../../../../src/features/action/pointer/UinputRoute";
import { defaultPointerRoutes } from "../../../../src/features/action/pointer/pointerRoutes";
import { selectPointerRoute } from "../../../../src/features/action/pointer/selectPointerRoute";

const env = (over: Partial<PointerEnvironment> = {}): PointerEnvironment => ({
  platform: "android",
  apiLevel: 30,
  capabilities: new Set(),
  rootShell: true,
  ...over,
});
const noop = async () => {};
const route = new UinputRoute(noop);

describe("UinputRoute (#13105)", () => {
  test("takes a stylus stroke with pressure and a path, and a stylus hover, on a root shell", () => {
    for (const features of [
      { toolType: "stylus" as const },
      { toolType: "stylus" as const, variablePressure: true, path: true },
      { toolType: "stylus" as const, hover: true },
    ]) {
      expect(route.supports(features, env())).toEqual({ supported: true });
    }
  });

  test("needs a root adb shell and says how to get one", () => {
    for (const rootShell of [false, undefined]) {
      const support = route.supports({ toolType: "stylus" }, env({ rootShell }));
      expect(support).toMatchObject({ supported: false });
      expect(support.supported ? "" : support.reason).toContain("adb root");
    }
  });

  test("refuses iOS, a finger, a mouse, and tilt, orientation or buttons", () => {
    expect(route.supports({ toolType: "stylus" }, env({ platform: "ios" })).supported).toBe(false);
    expect(route.supports({ toolType: "finger" }, env()).supported).toBe(false);
    expect(route.supports({ toolType: "mouse", hover: true }, env()).supported).toBe(false);
    const axes = route.supports({ toolType: "stylus", extendedAxes: true }, env());
    expect(axes.supported ? "" : axes.reason).toContain("tilt, orientation and barrel buttons");
  });

  const routes = () =>
    defaultPointerRoutes({ a11y: noop, adbInputSource: noop, instrumentation: noop, uinput: noop });

  test("comes last, so a runner that can inject without root still wins", () => {
    const withRunner = env({ capabilities: new Set(["stylus_input_v1"]), apiLevel: 34 });
    const choice = selectPointerRoute(
      { toolType: "stylus", variablePressure: true },
      withRunner,
      routes(),
    );
    expect(choice.selected?.route).toBe("instrumentation");
  });

  test("carries a pressure stroke a rooted device's runner cannot", () => {
    const choice = selectPointerRoute(
      { toolType: "stylus", variablePressure: true },
      env(),
      routes(),
    );
    expect(choice.selected?.route).toBe("uinput");
  });
});
