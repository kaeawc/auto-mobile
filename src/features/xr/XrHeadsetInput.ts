import { ActionableError } from "../../models/ActionableError";
import { consolePortFromSerial } from "../../utils/android-cmdline-tools/EmulatorConsoleClient";
import type {
  EmulatorGrpcDiscovery,
  EmulatorGrpcEndpoint,
} from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import {
  STREAM_INPUT_EVENT_METHOD,
  type EmulatorInputEventSender,
} from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorInputEventClient";
import {
  encodeXrPointerInputEvent,
  XR_INPUT_EVENT_FIELD_NAME,
  XR_POINTER_BUTTONS,
  type XrPointerChannel,
  type XrPointerEvent,
} from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorXrInputMessages";

export const XR_POINTERS = ["hand", "eye"] as const satisfies readonly XrPointerChannel[];
export const XR_POINTER_ACTIONS = ["select", "point", "drag"] as const;
export type XrPointerAction = (typeof XR_POINTER_ACTIONS)[number];

export const XR_MAX_COORDINATE = 16_384;
export const XR_DEFAULT_HOLD_MS = 100;
export const XR_MAX_HOLD_MS = 5_000;
export const XR_DEFAULT_DRAG_MS = 300;
export const XR_MAX_DRAG_MS = 10_000;
/** Pause after aiming so the guest moves the ray or gaze before the press lands. */
export const XR_AIM_SETTLE_MS = 50;
export const XR_DRAG_STEPS = 10;

export interface XrHeadsetInputRequest {
  pointer: XrPointerChannel;
  action: XrPointerAction;
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  holdMs?: number;
  durationMs?: number;
  signal?: AbortSignal;
}

export interface XrHeadsetInputResult {
  success: true;
  message: string;
  pointer: XrPointerChannel;
  action: XrPointerAction;
  /** The gRPC method the events were sent on. */
  rpc: string;
  /** The `InputEvent` oneof field that carried each event. */
  field: (typeof XR_INPUT_EVENT_FIELD_NAME)[XrPointerChannel];
  events: Array<Pick<XrPointerEvent, "x" | "y" | "buttons">>;
}

export interface PlannedXrPointerEvent {
  event: XrPointerEvent;
  delayAfterMs: number;
}

function endpoint(request: XrHeadsetInputRequest): { toX: number; toY: number } {
  if (request.toX === undefined || request.toY === undefined) {
    throw new ActionableError("xrHeadsetInput drag needs toX and toY, the point to release at.");
  }
  if (request.pointer !== "hand") {
    throw new ActionableError(
      "xrHeadsetInput drag is hand-only: the emulator pinches and drags with the hand ray. Use pointer: 'hand', or action: 'select' for a gaze click.",
    );
  }
  return { toX: request.toX, toY: request.toY };
}

/**
 * The `MouseEvent` sequence Android Studio's embedded emulator sends for the same mouse gesture
 * in hand or eye input mode: buttons 0 aims, 1 holds the pinch or gaze click, 0 releases.
 */
export function planXrPointerEvents(request: XrHeadsetInputRequest): PlannedXrPointerEvent[] {
  const { pointer: channel, x, y } = request;
  const at = (px: number, py: number, buttons: number): XrPointerEvent => ({
    channel,
    x: px,
    y: py,
    buttons,
  });
  const aim = { event: at(x, y, XR_POINTER_BUTTONS.none), delayAfterMs: XR_AIM_SETTLE_MS };
  if (request.action === "point") {
    return [{ ...aim, delayAfterMs: 0 }];
  }
  if (request.action === "select") {
    return [
      aim,
      {
        event: at(x, y, XR_POINTER_BUTTONS.primary),
        delayAfterMs: request.holdMs ?? XR_DEFAULT_HOLD_MS,
      },
      { event: at(x, y, XR_POINTER_BUTTONS.none), delayAfterMs: 0 },
    ];
  }
  const { toX, toY } = endpoint(request);
  const stepMs = Math.round((request.durationMs ?? XR_DEFAULT_DRAG_MS) / XR_DRAG_STEPS);
  const moves = Array.from({ length: XR_DRAG_STEPS }, (_, index) => {
    const fraction = (index + 1) / XR_DRAG_STEPS;
    return {
      event: at(
        Math.round(x + (toX - x) * fraction),
        Math.round(y + (toY - y) * fraction),
        XR_POINTER_BUTTONS.primary,
      ),
      delayAfterMs: stepMs,
    };
  });
  return [
    aim,
    { event: at(x, y, XR_POINTER_BUTTONS.primary), delayAfterMs: stepMs },
    ...moves,
    { event: at(toX, toY, XR_POINTER_BUTTONS.none), delayAfterMs: 0 },
  ];
}

export interface XrHeadsetInputInjector {
  inject(request: XrHeadsetInputRequest): Promise<XrHeadsetInputResult>;
}

export class GrpcXrHeadsetInputInjector implements XrHeadsetInputInjector {
  constructor(private readonly sender: EmulatorInputEventSender) {}

  async inject(request: XrHeadsetInputRequest): Promise<XrHeadsetInputResult> {
    const planned = planXrPointerEvents(request);
    await this.sender.send(
      planned.map(({ event, delayAfterMs }) => ({
        message: encodeXrPointerInputEvent(event),
        delayAfterMs,
      })),
      request.signal,
    );
    return {
      success: true,
      message: `Sent ${planned.length} ${request.pointer} ${request.action} event(s). The emulator does not acknowledge XR input; observe afterwards to verify the effect.`,
      pointer: request.pointer,
      action: request.action,
      rpc: STREAM_INPUT_EVENT_METHOD.slice(1),
      field: XR_INPUT_EVENT_FIELD_NAME[request.pointer],
      events: planned.map(({ event: { x, y, buttons } }) => ({ x, y, buttons })),
    };
  }
}

/** The gRPC endpoint of a local emulator serial, or an actionable error naming why there is none. */
export async function resolveXrInputEndpoint(
  deviceId: string,
  discovery: EmulatorGrpcDiscovery,
): Promise<EmulatorGrpcEndpoint> {
  const consolePort = consolePortFromSerial(deviceId);
  if (consolePort === null) {
    throw new ActionableError(
      `xrHeadsetInput drives the emulator's gRPC input stream; '${deviceId}' is not a local emulator.`,
    );
  }
  const found = await discovery.findByConsolePort(consolePort);
  if (!found) {
    throw new ActionableError(
      `Emulator ${deviceId} does not advertise a gRPC endpoint. Use an emulator build with gRPC enabled (the default on recent builds) running on this host.`,
    );
  }
  return found;
}
