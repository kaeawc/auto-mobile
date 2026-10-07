/** Swift request models decode these millisecond fields as Int/Int64. */
const integerMillisecondsByRequest: Readonly<Record<string, readonly string[]>> = {
  request_tap_coordinates: ["duration"],
  request_action: ["duration"],
  request_drag: ["pressDurationMs", "dragDurationMs", "holdDurationMs", "holdTime"],
  request_swipe: ["duration"],
  request_pinch: ["duration"],
  request_two_finger_swipe: ["duration"],
  request_multi_finger_swipe: ["duration"],
  set_hierarchy_poll_interval: ["intervalMs"],
};

/**
 * Envelope fields every request may carry. The runner reads `timeoutMs` (the host's request
 * timeout) for every command and only accepts a positive integer (#10084).
 */
const envelopeIntegerMilliseconds: readonly string[] = ["timeoutMs"];

export interface SerializeIosRequestOptions {
  /**
   * The host's timeout for this request. Put on the wire as `timeoutMs` (unless the payload
   * already sets one) so the runner drops the command, unstarted, if it is still queued behind
   * a slower command after the host stopped waiting (#10084).
   */
  timeoutMs?: number;
}

function withRequestTimeout(
  message: Record<string, unknown>,
  timeoutMs: number | undefined,
): Record<string, unknown> {
  const hasBudget = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
  return hasBudget && message.timeoutMs === undefined ? { ...message, timeoutMs } : message;
}

/** Normalize only runner-owned timing fields; preserve coordinates and opaque payloads. */
export function serializeIosRequest(
  message: Record<string, unknown>,
  options: SerializeIosRequestOptions = {},
): string {
  const wire = withRequestTimeout(message, options.timeoutMs);
  const fields = [
    ...envelopeIntegerMilliseconds,
    ...(integerMillisecondsByRequest[String(wire.type)] ?? []),
  ];
  return JSON.stringify(wire, function (key, value: unknown) {
    const isMilliseconds = this === wire && fields.includes(key);
    return isMilliseconds && typeof value === "number" && Number.isFinite(value)
      ? value > 0
        ? Math.max(1, Math.round(value))
        : Math.round(value)
      : value;
  });
}
