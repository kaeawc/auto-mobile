import type { PrototypeEvent } from "../../src/features/observe/android/ctrlProxyProtocol";

export function event(
  sequence: number,
  id = "panel",
  kind: PrototypeEvent["kind"] = "emit",
  name = "save",
): PrototypeEvent {
  return {
    type: "prototype_event",
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
