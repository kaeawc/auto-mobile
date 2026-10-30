import { describe, expect, test } from "bun:test";
import { PressButton } from "../../src/features/action/PressButton";
import type { DaemonRequest } from "../../src/daemon/types";
import { inputRouteFor } from "../../src/daemon/inputRoutes";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { androidDevice, createFakeDaemonState } from "./helpers/inputSocketHarness";

/**
 * #11813: the order every `input/*` route runs its steps in, pinned before the handlers are
 * folded onto one runner: parse, device resolve, keyed callback, abort check, (typeText: device
 * re-resolve), frame-context check, budget check, dispatch, and the idle stamp (`dispatching`)
 * only once dispatch has started. A pre-dispatch refusal never stamps.
 *
 * The private seams are replaced with recorders; no device, listener or timer runs.
 */

type Events = string[];

function harness(options: { frameRefusal?: boolean; budgetRefusal?: boolean } = {}) {
  const events: Events = [];
  const server = createTestUnixSocketServer(
    "/fake/order.sock",
    createFakeDaemonState(),
    new FakeTimer(),
  ).testHooks.input;
  server.resolveInputTargetDevice = async (
    _platform,
    _deviceId,
    _session,
    { action, bypassAndroidDeviceListCache },
  ) => {
    events.push(`resolve:${action}:${bypassAndroidDeviceListCache === true}`);

    return androidDevice;
  };
  server.runTrackedKeyedDeviceInput = async (method, _device, operation) => {
    events.push(`keyed:${method}`);
    const controller = new AbortController();
    return await operation(controller.signal, () => events.push("dispatching"));
  };
  server.requireCurrentFrameContext = (_device, frameContext, label) => {
    events.push(`frame:${label}:${frameContext}`);
    if (options.frameRefusal) {
      throw new Error("stale frame");
    }
  };
  server.remainingInputBudgetMs = (method) => {
    events.push(`budget:${method}`);
    if (options.budgetRefusal) {
      throw new Error("budget spent");
    }
    return 1000;
  };
  server.dispatchFencedInput = async (gesture, _signal, _timeout, { send: _send, onDispatch }) => {
    events.push(`dispatch:${gesture}`);
    onDispatch?.();
    return { success: true } as never;
  };
  server.executeSocketInputKey = (async (_key: unknown, options: { dispatching?: () => void }) => {
    events.push("dispatch:key");
    options.dispatching?.();
    return { success: true };
  }) as never;
  server.executeInputTypeText = async (_platform, _device, _text, typeTextOptions) => {
    events.push("dispatch:typeText");
    typeTextOptions.dispatching?.();
    return { success: true };
  };
  server.liftingStrokeOnSessionRefusal = async (kind, _session, _device, _id, run) => {
    events.push(`lift:${kind}`);
    return await run();
  };
  server.captureStrokeAdmission = () => {
    events.push("admission");
    return {} as never;
  };
  server.forwardGestureFrame = ((_client: unknown, kind: string) => {
    events.push(`dispatch:gesture:${kind}`);
    return Promise.resolve({ success: true });
  }) as never;
  server.forwardGestureStart = (() => {
    events.push("dispatch:gesture:start");
    return Promise.resolve({ success: true });
  }) as never;
  server.trackAckedGestureFrame = async (kind) => {
    events.push(`track:${kind}`);
  };
  return { server, events };
}

const FRAME = { frameContext: "ctx" };
const BASE = { platform: "android" };

interface Route {
  method: string;
  params: Record<string, unknown>;
  /** Whether the route checks the frame context. */
  framed: boolean;
}

const ROUTES: Route[] = [
  { method: "input/tap", params: { ...BASE, ...FRAME, x: 1, y: 2 }, framed: true },
  {
    method: "input/swipe",
    params: { ...BASE, ...FRAME, startX: 1, startY: 2, endX: 3, endY: 4 },
    framed: true,
  },
  { method: "input/typeText", params: { ...BASE, ...FRAME, text: "a" }, framed: true },
  { method: "input/pressButton", params: { ...BASE, ...FRAME, button: "home" }, framed: true },
  { method: "input/key", params: { ...BASE, ...FRAME, key: "enter" }, framed: true },
  {
    method: "input/gestureStart",
    params: { ...BASE, gestureId: "g", x: 1, y: 2 },
    framed: false,
  },
  { method: "input/gestureMove", params: { ...BASE, gestureId: "g", x: 1, y: 2 }, framed: false },
  { method: "input/gestureEnd", params: { ...BASE, gestureId: "g", x: 1, y: 2 }, framed: false },
];

async function drive(route: Route, options: Parameters<typeof harness>[0] = {}) {
  const { server, events } = harness(options);
  const press = PressButton.prototype;
  const originalPress = press.press;
  press.press = async function (
    this: PressButton,
    _button: string,
    options: { onDispatch?: () => void } = {},
  ) {
    events.push("dispatch:pressButton");
    options.onDispatch?.();
    return { success: true } as never;
  } as never;
  const request = { id: "1", type: "mcp_request", method: route.method, params: route.params };
  try {
    await server.dispatchInputRoute(
      inputRouteFor(route.method)!,
      request as DaemonRequest,
      "socket-session",
      {},
    );
  } catch (error) {
    events.push(`refused:${(error as Error).message}`);
  } finally {
    press.press = originalPress;
  }
  return events;
}

const SUCCESS_ORDER: Record<string, string[]> = {
  "input/tap": [
    "resolve:input/tap:false",
    "keyed:input/tap",
    "frame:input/tap:ctx",
    "budget:input/tap",
    "dispatch:Tap",
    "dispatching",
  ],
  "input/swipe": [
    "resolve:input/swipe:false",
    "keyed:input/swipe",
    "frame:input/swipe:ctx",
    "budget:input/swipe",
    "dispatch:Swipe",
    "dispatching",
  ],
  "input/typeText": [
    "resolve:input/typeText:false",
    "keyed:input/typeText",
    "frame:input/typeText:ctx",
    "budget:input/typeText",
    "dispatch:typeText",
    "dispatching",
  ],
  "input/pressButton": [
    "resolve:input/pressButton:false",
    "keyed:input/pressButton",
    "frame:input/pressButton:ctx",
    "budget:input/pressButton",
    "dispatch:pressButton",
    "dispatching",
  ],
  "input/key": [
    "resolve:input/key:false",
    "keyed:input/key",
    "frame:input/key:ctx",
    "budget:input/key",
    "dispatch:key",
    "dispatching",
  ],
  "input/gestureStart": [
    "resolve:input/gestureStart:false",
    "lift:start",
    "keyed:input/gestureStart",
    "budget:input/gestureStart",
    "dispatching",
    "admission",
    "dispatch:gesture:start",
    "track:start",
  ],
  "input/gestureMove": [
    "resolve:input/gestureMove:false",
    "lift:move",
    "keyed:input/gestureMove",
    "budget:input/gestureMove",
    "dispatching",
    "dispatch:gesture:move",
    "track:move",
  ],
  "input/gestureEnd": [
    "resolve:input/gestureEnd:false",
    "lift:end",
    "keyed:input/gestureEnd",
    "budget:input/gestureEnd",
    "dispatching",
    "dispatch:gesture:end",
    "track:end",
  ],
};

describe("input/* route step order (#11813)", () => {
  for (const route of ROUTES) {
    test(`${route.method}: success order`, async () => {
      expect(await drive(route)).toEqual(SUCCESS_ORDER[route.method]);
    });
    test(`${route.method}: spent budget refuses before any dispatch or idle stamp`, async () => {
      const events = await drive(route, { budgetRefusal: true });
      expect(events.some((event) => event.startsWith("dispatch"))).toBe(false);
      expect(events).not.toContain("dispatching");
      expect(events.at(-1)).toBe("refused:budget spent");
    });
    if (route.framed) {
      test(`${route.method}: a stale frame refuses before the budget check and any stamp`, async () => {
        const events = await drive(route, { frameRefusal: true });
        expect(events).not.toContain("dispatching");
        expect(events.some((event) => event.startsWith("budget"))).toBe(false);
        expect(events.at(-1)).toBe("refused:stale frame");
      });
    }
  }

  test("input/typeText append: re-resolves the device in the keyed callback before the frame check", async () => {
    const events = await drive({
      method: "input/typeText",
      params: { ...BASE, ...FRAME, text: "a", mode: "append" },
      framed: true,
    });
    expect(events).toEqual([
      "resolve:input/typeText:true",
      "keyed:input/typeText",
      "resolve:input/typeText:true",
      "frame:input/typeText:ctx",
      "budget:input/typeText",
      "dispatch:typeText",
      "dispatching",
    ]);
  });

  test("an owner that left is refused before the frame and budget checks", async () => {
    const { server, events } = harness();
    server.runTrackedKeyedDeviceInput = async (method, _device, operation) => {
      events.push(`keyed:${method}`);
      const controller = new AbortController();
      controller.abort(new Error("owner left"));
      return await operation(controller.signal, () => events.push("dispatching"));
    };
    const request = {
      id: "1",
      type: "mcp_request",
      method: "input/tap",
      params: { ...BASE, ...FRAME, x: 1, y: 2 },
    };
    await expect(
      server.dispatchInputRoute(inputRouteFor("input/tap")!, request as DaemonRequest, "s", {}),
    ).rejects.toThrow("owner left");
    expect(events).toEqual(["resolve:input/tap:false", "keyed:input/tap"]);
  });
});
