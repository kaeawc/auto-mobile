import { describe, expect, test } from "bun:test";
import { createRequestContext } from "../../src/daemon/requestContext";
import type { DaemonRequest } from "../../src/daemon/types";

/** #11817: one owner-signal holder per request, read by admission and dispatch alike. */
const frame = (id: string): DaemonRequest => ({
  id,
  type: "mcp_request",
  method: "tools/call",
  params: { name: "observe" },
});

describe("RequestContext owner signal", () => {
  test("is unset until dispatch adopts a signal, then reports the latest one", () => {
    const context = createRequestContext(frame("1"), "socket-session", 0);
    expect(context.owner.signal).toBeUndefined();
    context.owner.adopt(context.signal);
    expect(context.owner.signal).toBe(context.signal);
    const forward = new AbortController();
    context.owner.adopt(forward.signal);
    expect(context.owner.signal).toBe(forward.signal);
  });

  test("each request owns its own holder", () => {
    const first = createRequestContext(frame("1"), "socket-session", 0);
    const second = createRequestContext(frame("2"), "socket-session", 0);
    first.owner.adopt(first.signal);
    expect(second.owner.signal).toBeUndefined();
  });
});
