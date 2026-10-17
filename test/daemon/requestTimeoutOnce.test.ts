import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  resolveMcpRequestTimeoutMs,
  resolveMcpRequestTimeoutMsOnce,
} from "../../src/daemon/mcpRequestTimeout";
import type { DaemonRequest } from "../../src/daemon/types";

/** #11817: one request budget per request, not one per reader. */
const PLAN = "name: p\nsteps:\n  - tool: observe\n";

function executePlanFrame(): DaemonRequest {
  return {
    id: "1",
    type: "mcp_request",
    method: "tools/call",
    params: { name: "executePlan", arguments: { planContent: PLAN } },
  };
}

describe("resolveMcpRequestTimeoutMsOnce", () => {
  test("agrees with the uncached budget for ordinary and plan frames", () => {
    const frames: DaemonRequest[] = [
      { id: "1", type: "mcp_request", method: "tools/list" },
      {
        id: "2",
        type: "mcp_request",
        method: "tools/call",
        timeoutMs: 1234,
        params: { name: "observe" },
      },
      executePlanFrame(),
    ];
    for (const frame of frames) {
      expect(resolveMcpRequestTimeoutMsOnce(frame)).toBe(resolveMcpRequestTimeoutMs(frame));
    }
  });

  test("an executePlan frame's plan is read (and so parsed) once however many readers ask", () => {
    let planReads = 0;
    const args = {
      get planContent(): string {
        planReads++;
        return PLAN;
      },
    };
    const frame: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "executePlan", arguments: args },
    };
    const first = resolveMcpRequestTimeoutMsOnce(frame);
    const readsForOneResolve = planReads;
    expect(readsForOneResolve).toBeGreaterThan(0);
    expect(resolveMcpRequestTimeoutMsOnce(frame)).toBe(first);
    expect(resolveMcpRequestTimeoutMsOnce(frame)).toBe(first);
    expect(planReads).toBe(readsForOneResolve);
    // The uncached resolver pays again on every call: the cost the cache removes.
    resolveMcpRequestTimeoutMs(frame);
    expect(planReads).toBe(readsForOneResolve * 2);
  });

  test("distinct request objects are resolved independently", () => {
    const a = executePlanFrame();
    const b = { ...executePlanFrame(), timeoutMs: 999_999 };
    expect(resolveMcpRequestTimeoutMsOnce(a)).toBe(resolveMcpRequestTimeoutMs(a));
    expect(resolveMcpRequestTimeoutMsOnce(b)).toBe(resolveMcpRequestTimeoutMs(b));
  });

  test("the socket server resolves a request's budget through the cache only", () => {
    const source = readFileSync("src/daemon/socketServer.ts", "utf8");
    expect(source).not.toMatch(/resolveMcpRequestTimeoutMs\(/);
    expect(source).toMatch(/resolveMcpRequestTimeoutMsOnce\(/);
  });
});
