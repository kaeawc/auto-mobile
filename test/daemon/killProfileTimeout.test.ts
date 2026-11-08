import { describe, expect, test } from "bun:test";
import { KILL_PROFILES, KILL_PROFILE_IDS } from "../../src/features/utility/KillProfiles";
import {
  KILL_PROFILE_MCP_TIMEOUT_HEADROOM_MS,
  resolveKillProfileBudgetMs,
} from "../../src/features/utility/killProfileTimeout";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  resolveMcpRequestTimeoutMs,
} from "../../src/daemon/mcpRequestTimeout";

function killProfileRequest(args: Record<string, unknown>) {
  return {
    id: "kill-profile",
    type: "mcp_request" as const,
    method: "tools/call",
    params: { name: "killProfile", arguments: args },
  };
}

describe("killProfile request budget", () => {
  test("apply screen-off-stop covers the dwell plus headroom", () => {
    const budget = 60_000 + KILL_PROFILE_MCP_TIMEOUT_HEADROOM_MS;
    expect(resolveKillProfileBudgetMs({ action: "apply", profile: "screen-off-stop" })).toBe(
      budget,
    );
    expect(
      resolveMcpRequestTimeoutMs(
        killProfileRequest({ action: "apply", appId: "a.b", profile: "screen-off-stop" }),
      ),
    ).toBe(budget);
    expect(budget).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("every profile with a screenOff step gets a budget above its dwell", () => {
    for (const id of KILL_PROFILE_IDS) {
      const dwell = KILL_PROFILES[id].steps.reduce(
        (sum, step) => sum + (step.kind === "screenOff" ? step.minutes * 60_000 : 0),
        0,
      );
      const budget = resolveKillProfileBudgetMs({ action: "apply", profile: id });
      expect(budget).toBe(dwell > 0 ? dwell + KILL_PROFILE_MCP_TIMEOUT_HEADROOM_MS : 0);
    }
  });

  test.each([
    { action: "apply", profile: "force-stop" },
    { action: "reset", profile: "screen-off-stop" },
    { action: "list" },
    { action: "apply", profile: "constructor" },
    { action: "apply" },
    {},
  ])("%j keeps the default deadline", (args) => {
    expect(resolveKillProfileBudgetMs(args)).toBe(0);
    expect(resolveMcpRequestTimeoutMs(killProfileRequest(args))).toBe(
      DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    );
  });
});
