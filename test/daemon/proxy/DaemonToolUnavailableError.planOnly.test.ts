import { describe, expect, test } from "bun:test";
import { DaemonToolUnavailableError } from "../../../src/daemon/proxy/DaemonToolUnavailableError";
import { planOnlyCallGuidance } from "../../../src/daemon/toolUnavailableError";

const identity = { entryScript: "/repo/dist/index.js", buildId: "abc123" };

describe("DaemonToolUnavailableError for plan-only tools (#19194)", () => {
  test("leads with the executePlan route instead of a configuration gate", () => {
    const error = new DaemonToolUnavailableError({
      toolName: "barrier",
      client: identity,
      daemon: identity,
      buildMismatch: false,
      gated: true,
      daemonRejection: `Unknown tool: barrier. plan-only tool: ${planOnlyCallGuidance("barrier")}`,
    });
    expect(error.message).toStartWith(
      'Tool "barrier" runs only as a step inside executePlan; a direct call is refused.',
    );
    expect(error.message).toContain("executePlan's devices list");
    expect(error.message).not.toContain("current configuration");
    expect(error.buildMismatch).toBe(false);
  });

  test("other gates keep the configuration wording", () => {
    const error = new DaemonToolUnavailableError({
      toolName: "debugTool",
      client: identity,
      daemon: identity,
      buildMismatch: false,
      gated: true,
      daemonRejection: "Unknown tool: debugTool. --debug is disabled",
    });
    expect(error.message).toContain("unavailable in the connected daemon's current configuration");
  });

  test("names the devices list in the guidance", () => {
    expect(planOnlyCallGuidance("criticalSection")).toBe(
      '"criticalSection" runs only as a step inside executePlan: put it in the plan\'s steps and ' +
        "pass the participating devices in executePlan's devices list; it cannot be called directly",
    );
  });
});
