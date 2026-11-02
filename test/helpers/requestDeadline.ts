import {
  type RequestDeadline,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";

/** Run `fn` as MCP ingress would for a request with this transport deadline (#15663). */
export function underRequestDeadline<T>(
  requestDeadline: RequestDeadline,
  fn: () => T | Promise<T>,
): Promise<T> {
  return runWithToolSelectionContext({ requestDeadline }, async () => await fn());
}

const WIRE_KEYS = {
  __mcpRequestDeadlineMs: "deadlineMs",
  __mcpRequestTimeoutMs: "timeoutMs",
  __executionStartTime: "startTime",
  __mcpLiveDeadlineKey: "liveDeadlineKey",
} as const;

/**
 * Call `fn` with `args` stripped of the daemon's in-band deadline keys, under the request deadline
 * those keys describe, as MCP ingress does (#15663). Lets a test keep writing the wire shape.
 */
export function withWireDeadline<A extends Record<string, unknown>, T>(
  args: A,
  fn: (args: Omit<A, keyof typeof WIRE_KEYS>) => T | Promise<T>,
): Promise<T> {
  const rest: Record<string, unknown> = { ...args };
  const requestDeadline: Record<string, unknown> = {};
  for (const [wireKey, field] of Object.entries(WIRE_KEYS)) {
    if (rest[wireKey] !== undefined) {
      requestDeadline[field] = rest[wireKey];
    }
    delete rest[wireKey];
  }
  return underRequestDeadline(requestDeadline as RequestDeadline, () =>
    fn(rest as Omit<A, keyof typeof WIRE_KEYS>),
  );
}
