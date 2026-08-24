import { describe, expect, test } from "bun:test";
import { INTERNAL_NO_DIFF_PARAM, markInternalToolCall } from "../../src/server/internalToolCall";

/**
 * Unit guard for the shared internal-tool-call helper (#3087). Every internal
 * wrapped-handler invocation (PlanExecutor steps, navigation/setup replays) must
 * opt into the no-diff guard through this one helper so a plan/navigation step's
 * finalized envelope is never diffed/stripped and never advances the agent-facing
 * diff baseline. Centralizing the marker removes the per-call-site footgun the
 * issue flagged.
 */
describe("markInternalToolCall (#3087)", () => {
  test("sets the internal no-diff marker to true", () => {
    const marked = markInternalToolCall({ text: "Go" });
    expect(marked[INTERNAL_NO_DIFF_PARAM]).toBe(true);
  });

  test("the marker constant matches the param the wrapped handler reads", () => {
    // The toolRegistry wrapper reads this exact key at entry; a drift here would
    // silently disable the guard, so pin the literal.
    expect(INTERNAL_NO_DIFF_PARAM).toBe("__internalNoDiff");
  });

  test("returns a shallow copy — does not mutate the caller's args", () => {
    // Navigation replays reuse a nav-graph edge's stored `interaction.args`;
    // mutating it in place would permanently taint shared graph state.
    const original: Record<string, unknown> = { text: "Go", platform: "android" };
    const before = JSON.stringify(original);
    const marked = markInternalToolCall(original);

    expect(marked).not.toBe(original);
    expect(original[INTERNAL_NO_DIFF_PARAM]).toBeUndefined();
    expect(JSON.stringify(original)).toBe(before);
  });

  test("preserves all existing args", () => {
    const marked = markInternalToolCall({ text: "Go", platform: "android", direction: "down" });
    expect(marked.text).toBe("Go");
    expect(marked.platform).toBe("android");
    expect(marked.direction).toBe("down");
  });
});
