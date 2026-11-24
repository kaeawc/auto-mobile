import { ProtoWriter } from "./protobufWire";

/**
 * The XR pointer variants of `InputEvent` from the emulator's `emulator_controller.proto`
 * (package `android.emulation.control`, emulator 35.4+): `MouseEvent xr_hand_event = 7` and
 * `MouseEvent xr_eye_event = 8`. Field numbers must match that file.
 */

export type XrPointerChannel = "hand" | "eye";

/** `MouseEvent.buttons`: 0 aims or hovers, bit 0 (primary) holds a pinch or a gaze click. */
export const XR_POINTER_BUTTONS = { none: 0, primary: 1 } as const;

export interface XrPointerEvent {
  channel: XrPointerChannel;
  /** Display pixels in the panel's natural (unrotated) frame, 0 at the left. */
  x: number;
  /** Display pixels, 0 at the top. */
  y: number;
  buttons: number;
}

export const XR_INPUT_EVENT_FIELD = { hand: 7, eye: 8 } as const;
export const XR_INPUT_EVENT_FIELD_NAME = { hand: "xr_hand_event", eye: "xr_eye_event" } as const;
const MOUSE_EVENT_FIELD = { x: 1, y: 2, buttons: 3, display: 4 } as const;

/** XR AVDs route every pointer event to display 0, so `display` stays at its default. */
export function encodeXrPointerInputEvent(event: XrPointerEvent): Uint8Array {
  const mouseEvent = new ProtoWriter()
    .varint(MOUSE_EVENT_FIELD.x, event.x)
    .varint(MOUSE_EVENT_FIELD.y, event.y)
    .varint(MOUSE_EVENT_FIELD.buttons, event.buttons)
    .finish();
  // An empty MouseEvent (0,0, no button) must still select the oneof case, so write the field even when empty.
  return new ProtoWriter().message(XR_INPUT_EVENT_FIELD[event.channel], mouseEvent).finish();
}
