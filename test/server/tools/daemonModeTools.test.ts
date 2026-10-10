import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerMcpTools } from "../../../src/server/index";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { setDebugModeEnabled } from "../../../src/utils/debug";

/**
 * Registration is the expensive step (12-30 ms), so each configuration is
 * registered once in beforeAll and captured as an immutable snapshot of plain
 * data. Tests assert on snapshots only, so they share no mutable state and are
 * order-independent.
 */
interface RegistrationSnapshot {
  discoverable: string[];
  direct: Record<string, boolean>;
  plan: Record<string, boolean>;
}

const PROBED_TOOLS = [
  "criticalSection",
  "barrier",
  "accessibilityFocus",
  "setUIState",
  "sqlQuery",
  "setKeyValue",
  "removeKeyValue",
  "clearKeyValueFile",
  "network",
  "mockNetwork",
  "clearMockNetwork",
  "getNetworkGraph",
];

function registerAndSnapshot(
  daemonMode: boolean,
  options: { debug?: boolean; embeddedSdk?: boolean } = {},
): RegistrationSnapshot {
  (ToolRegistry as any).tools.clear();
  setDebugModeEnabled(options.debug === true);
  serverConfig.setEmbeddedSdkEnabled(options.embeddedSdk === true);
  try {
    registerMcpTools(daemonMode);
    const direct: Record<string, boolean> = {};
    const plan: Record<string, boolean> = {};
    for (const name of PROBED_TOOLS) {
      direct[name] = ToolRegistry.getTool(name) !== undefined;
      plan[name] = ToolRegistry.getToolForPlan(name) !== undefined;
    }
    return {
      discoverable: ToolRegistry.getToolDefinitions().map((tool) => tool.name),
      direct,
      plan,
    };
  } finally {
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
    (ToolRegistry as any).tools.clear();
  }
}

describe("Daemon-only MCP tools", () => {
  let standalone: RegistrationSnapshot;
  let daemon: RegistrationSnapshot;
  let debug: RegistrationSnapshot;
  let embedded: RegistrationSnapshot;

  beforeAll(() => {
    standalone = registerAndSnapshot(false);
    daemon = registerAndSnapshot(true);
    debug = registerAndSnapshot(false, { debug: true });
    embedded = registerAndSnapshot(false, { embeddedSdk: true });
  });

  afterAll(() => {
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
    (ToolRegistry as any).tools.clear();
  });

  test("registers plan tools in both modes, criticalSection only in daemon mode", () => {
    expect(standalone.discoverable).toContain("executePlan");
    expect(standalone.discoverable).not.toContain("criticalSection");
  });

  test("registers criticalSection/barrier plan-only in daemon mode (hidden from discovery, usable in plans)", () => {
    expect(daemon.discoverable).toContain("executePlan");
    // Plan-only coordination primitives are registered in daemon mode but hidden
    // from normal discovery - a single direct call would just block.
    expect(daemon.discoverable).not.toContain("criticalSection");
    expect(daemon.discoverable).not.toContain("barrier");
    expect(daemon.direct.criticalSection).toBe(false);
    expect(daemon.direct.barrier).toBe(false);
    // ...but resolvable for plan execution.
    expect(daemon.plan.criticalSection).toBe(true);
    expect(daemon.plan.barrier).toBe(true);
  });

  test("hides debug-only tools unless debug mode is enabled", () => {
    expect(standalone.direct.accessibilityFocus).toBe(false);
    expect(standalone.direct.setUIState).toBe(false);
    expect(standalone.plan.accessibilityFocus).toBe(false);
    expect(standalone.plan.setUIState).toBe(true);
    expect(standalone.discoverable).not.toContain("accessibilityFocus");
    expect(standalone.discoverable).not.toContain("setUIState");

    expect(debug.direct.accessibilityFocus).toBe(true);
    expect(debug.direct.setUIState).toBe(true);
    expect(debug.plan.accessibilityFocus).toBe(true);
    expect(debug.plan.setUIState).toBe(true);
    expect(debug.discoverable).toContain("accessibilityFocus");
    expect(debug.discoverable).toContain("setUIState");
  });

  test("hides embedded-SDK tools unless embedded SDK mode is enabled", () => {
    const embeddedSdkTools = [
      "sqlQuery",
      "setKeyValue",
      "removeKeyValue",
      "clearKeyValueFile",
      "network",
      "mockNetwork",
      "clearMockNetwork",
      "getNetworkGraph",
    ];

    for (const toolName of embeddedSdkTools) {
      expect(standalone.direct[toolName]).toBe(false);
      expect(standalone.discoverable).not.toContain(toolName);
    }

    for (const toolName of embeddedSdkTools) {
      expect(embedded.direct[toolName]).toBe(true);
      expect(embedded.discoverable).toContain(toolName);
    }
  });
});
