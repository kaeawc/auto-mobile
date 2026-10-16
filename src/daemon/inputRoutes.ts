/**
 * The control-socket `input/*` route table (#11813). Every method the socket serves under
 * `input/` is declared here once: which handler runs it, and whether its device write holds the
 * request open until the device replies. Admission sets and the dispatcher read this table instead
 * of repeating method-name strings.
 */

export type InputRouteHandler = "tap" | "swipe" | "typeText" | "pressButton" | "key" | "gesture";

export type GestureFrameKind = "start" | "move" | "end";

export interface InputRoute {
  readonly method: string;
  readonly handler: InputRouteHandler;
  /** Set for the stroke frames served by the gesture handler. */
  readonly gestureKind?: GestureFrameKind;
  /**
   * The request is held until the device replies to its single write. Stroke frames need no extra
   * hold: no signal reaches their atomic runner command and stroke lift handles cancellation.
   */
  readonly dispatchHeld: boolean;
}

export const INPUT_ROUTES = [
  { method: "input/tap", handler: "tap", dispatchHeld: true },
  { method: "input/swipe", handler: "swipe", dispatchHeld: true },
  { method: "input/typeText", handler: "typeText", dispatchHeld: true },
  { method: "input/pressButton", handler: "pressButton", dispatchHeld: true },
  { method: "input/key", handler: "key", dispatchHeld: true },
  { method: "input/gestureStart", handler: "gesture", gestureKind: "start", dispatchHeld: false },
  { method: "input/gestureMove", handler: "gesture", gestureKind: "move", dispatchHeld: false },
  { method: "input/gestureEnd", handler: "gesture", gestureKind: "end", dispatchHeld: false },
] as const satisfies readonly InputRoute[];

export type InputRouteMethod = (typeof INPUT_ROUTES)[number]["method"];

const ROUTES_BY_METHOD: ReadonlyMap<string, InputRoute> = new Map(
  INPUT_ROUTES.map((route) => [route.method, route]),
);

export function inputRouteFor(method: string): InputRoute | undefined {
  return ROUTES_BY_METHOD.get(method);
}

export const DISPATCH_HELD_INPUT_METHODS: ReadonlySet<string> = new Set(
  INPUT_ROUTES.filter((route) => route.dispatchHeld).map((route) => route.method),
);

/** The frame method each gesture stroke kind arrives as. */
export const GESTURE_FRAME_METHODS: Readonly<Record<GestureFrameKind, InputRouteMethod>> = {
  start: "input/gestureStart",
  move: "input/gestureMove",
  end: "input/gestureEnd",
};
