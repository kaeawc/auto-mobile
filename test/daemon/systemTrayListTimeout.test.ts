import { describe, expect, test } from "bun:test";
import {
  SYSTEM_TRAY_LIST_MCP_TIMEOUT_HEADROOM_MS,
  WATCH_LIST_SCAN_TIMEOUT_MS,
} from "../../src/features/systemTray/watchListTimeout";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  resolveMcpRequestTimeoutMs,
} from "../../src/daemon/mcpRequestTimeout";

function systemTrayRequest(args: Record<string, unknown>) {
  return {
    id: "system-tray",
    type: "mcp_request" as const,
    method: "tools/call",
    params: { name: "systemTray", arguments: args },
  };
}

describe("systemTray list request budget", () => {
  test("list without awaitTimeout covers the full-scroll scan deadline plus headroom", () => {
    const budget = WATCH_LIST_SCAN_TIMEOUT_MS + SYSTEM_TRAY_LIST_MCP_TIMEOUT_HEADROOM_MS;
    expect(
      resolveMcpRequestTimeoutMs(
        systemTrayRequest({ action: "list", notification: { appId: "com.android.shell" } }),
      ),
    ).toBe(budget);
    expect(budget).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("list with awaitTimeout covers that scan deadline plus headroom", () => {
    expect(
      resolveMcpRequestTimeoutMs(
        systemTrayRequest({
          action: "list",
          notification: { appId: "com.android.shell" },
          awaitTimeout: 60_000,
        }),
      ),
    ).toBe(60_000 + SYSTEM_TRAY_LIST_MCP_TIMEOUT_HEADROOM_MS);
  });

  test.each([
    { action: "find" },
    { action: "tap" },
    { action: "clearAll" },
    { action: "open" },
    {},
  ])("%j keeps the default deadline", (args) => {
    expect(resolveMcpRequestTimeoutMs(systemTrayRequest(args))).toBe(
      DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    );
  });
});
