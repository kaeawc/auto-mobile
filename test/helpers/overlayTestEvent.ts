import type { OverlayEvent } from "../../src/features/observe/android/ctrlProxyProtocol";

export function event(
  sequence: number,
  id = "panel",
  kind: OverlayEvent["kind"] = "emit",
  name = "save",
): OverlayEvent {
  return {
    type: "overlay_event",
    id,
    sequence,
    kind,
    name,
    payload: { value: sequence },
    state: { title: "Hello" },
    pages: {},
    timestamp: sequence,
  };
}
