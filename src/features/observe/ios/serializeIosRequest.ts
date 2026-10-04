/** Swift request models decode these millisecond fields as Int/Int64. */
const integerMillisecondsByRequest: Readonly<Record<string, readonly string[]>> = {
  request_tap_coordinates: ["duration"],
  request_action: ["duration"],
  request_drag: ["pressDurationMs", "dragDurationMs", "holdDurationMs", "holdTime"],
  request_swipe: ["duration", "timeoutMs"],
  request_pinch: ["duration"],
  request_two_finger_swipe: ["duration"],
  request_multi_finger_swipe: ["duration"],
  set_hierarchy_poll_interval: ["intervalMs"],
};

/** Normalize only runner-owned timing fields; preserve coordinates and opaque payloads. */
export function serializeIosRequest(message: Record<string, unknown>): string {
  const fields = integerMillisecondsByRequest[String(message.type)] ?? [];
  return JSON.stringify(message, function (key, value: unknown) {
    const isMilliseconds = this === message && fields.includes(key);
    return isMilliseconds && typeof value === "number" && Number.isFinite(value)
      ? value > 0
        ? Math.max(1, Math.round(value))
        : Math.round(value)
      : value;
  });
}
