/**
 * The control-socket `input/*` route table (#11813). Every method the socket serves under
 * `input/` is declared here once: which handler runs it, and whether its device write holds the
 * request open until the device replies. Admission sets and the dispatcher read this table instead
 * of repeating method-name strings.
 */

import {
  parseInputGestureParams,
  parseInputKeyParams,
  parseInputPressButtonParams,
  parseInputSwipeParams,
  parseInputTapParams,
  parseInputTypeTextParams,
} from "./inputRouteParams";

export type InputRouteHandler = "tap" | "swipe" | "typeText" | "pressButton" | "key" | "gesture";

export type GestureFrameKind = "start" | "move" | "end";

export interface InputRoute {
  readonly method: string;
  readonly handler: InputRouteHandler;
  /** Parses and validates the route's params; throws the route's refusal `Error`. */
  readonly parse: (params: unknown) => unknown;
  /** Set for the stroke frames served by the gesture handler. */
  readonly gestureKind?: GestureFrameKind;
  /**
   * The request is held until the device replies to its single write. Stroke frames need no extra
   * hold: no signal reaches their atomic runner command and stroke lift handles cancellation.
   */
  readonly dispatchHeld: boolean;
}

export const INPUT_ROUTES = [
  { method: "input/tap", handler: "tap", parse: parseInputTapParams, dispatchHeld: true },
  { method: "input/swipe", handler: "swipe", parse: parseInputSwipeParams, dispatchHeld: true },
  {
    method: "input/typeText",
    handler: "typeText",
    parse: parseInputTypeTextParams,
    dispatchHeld: true,
  },
  {
    method: "input/pressButton",
    handler: "pressButton",
    parse: parseInputPressButtonParams,
    dispatchHeld: true,
  },
  { method: "input/key", handler: "key", parse: parseInputKeyParams, dispatchHeld: true },
  {
    method: "input/gestureStart",
    handler: "gesture",
    gestureKind: "start",
    parse: (params: unknown) => parseInputGestureParams(params, "input/gestureStart"),
    dispatchHeld: false,
  },
  {
    method: "input/gestureMove",
    handler: "gesture",
    gestureKind: "move",
    parse: (params: unknown) => parseInputGestureParams(params, "input/gestureMove"),
    dispatchHeld: false,
  },
  {
    method: "input/gestureEnd",
    handler: "gesture",
    gestureKind: "end",
    parse: (params: unknown) => parseInputGestureParams(params, "input/gestureEnd"),
    dispatchHeld: false,
  },
] as const satisfies readonly InputRoute[];

/** A table entry, narrowed by `handler` so each handler gets its own parsed params type. */
export type InputRouteEntry = (typeof INPUT_ROUTES)[number];

export type InputRouteMethod = (typeof INPUT_ROUTES)[number]["method"];

const ROUTES_BY_METHOD: ReadonlyMap<string, InputRouteEntry> = new Map(
  INPUT_ROUTES.map((route) => [route.method, route]),
);

export function inputRouteFor(method: string): InputRouteEntry | undefined {
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
