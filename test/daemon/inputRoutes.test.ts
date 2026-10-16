import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DISPATCH_HELD_INPUT_METHODS,
  GESTURE_FRAME_METHODS,
  INPUT_ROUTES,
  inputRouteFor,
} from "../../src/daemon/inputRoutes";

/** #11813: the control socket's `input/*` routes are declared once, in a table. */
describe("input/* route table", () => {
  test("every route is an input/ method, registered once, with a handler", () => {
    const methods = INPUT_ROUTES.map((route) => route.method);
    expect(new Set(methods).size).toBe(methods.length);
    for (const route of INPUT_ROUTES) {
      expect(route.method.startsWith("input/")).toBe(true);
      expect(route.handler.length).toBeGreaterThan(0);
      expect(inputRouteFor(route.method)).toBe(route);
    }
  });

  test("only stroke frames go to the gesture handler, each with its kind", () => {
    const gestures = INPUT_ROUTES.filter((route) => route.handler === "gesture");
    expect(gestures.map((route) => route.method).sort()).toEqual(
      Object.values(GESTURE_FRAME_METHODS).sort(),
    );
    for (const route of INPUT_ROUTES) {
      expect("gestureKind" in route).toBe(route.handler === "gesture");
    }
    for (const [kind, method] of Object.entries(GESTURE_FRAME_METHODS)) {
      expect(inputRouteFor(method)).toMatchObject({ gestureKind: kind });
    }
  });

  test("dispatch-held methods are exactly the non-stroke routes (unchanged set)", () => {
    expect([...DISPATCH_HELD_INPUT_METHODS].sort()).toEqual([
      "input/key",
      "input/pressButton",
      "input/swipe",
      "input/tap",
      "input/typeText",
    ]);
  });

  test("unknown and ide/* methods are not input routes", () => {
    expect(inputRouteFor("input/bogus")).toBeUndefined();
    expect(inputRouteFor("ide/status")).toBeUndefined();
  });

  test("the socket server keeps no input/ method-name dispatch chain", () => {
    const source = readFileSync("src/daemon/socketServer.ts", "utf8");
    expect(source).not.toMatch(/request\.method === "input\//);
  });
});
