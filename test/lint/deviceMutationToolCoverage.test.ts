import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { registerMcpTools } from "../../src/server";
import { registerDoctorTools } from "../../src/server/doctorTools";
import { ToolRegistry, ToolRegistryClass } from "../../src/server/toolRegistry";
import {
  DEVICE_MUTATION_TOOL_COVERAGE,
  mutationToolCoverageViolations,
} from "../../src/daemon/sessionBroker/mutations/toolCoverage";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { serverConfig } from "../../src/utils/ServerConfig";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

describe("device mutation tool coverage", () => {
  let previousDebugMode = false;

  beforeAll(() => {
    previousDebugMode = isDebugModeEnabled();
    setDebugModeEnabled(true);
    serverConfig.setEmbeddedSdkEnabled(true);
    ToolRegistry.clearTools();
    registerMcpTools(true);
    registerDoctorTools();
  });
  afterAll(() => {
    ToolRegistry.clearTools();
    serverConfig.setEmbeddedSdkEnabled(false);
    setDebugModeEnabled(previousDebugMode);
  });

  test("every mutating registry tool including mixed, hidden and SDK tools has a journaled adapter or justification", () => {
    const tools = ToolRegistry.getEveryRegisteredTool();
    expect(tools.length).toBeGreaterThan(80);
    expect(mutationToolCoverageViolations(tools)).toEqual([]);
    const names = new Set(tools.map((tool) => tool.name));
    expect(Object.keys(DEVICE_MUTATION_TOOL_COVERAGE).filter((name) => !names.has(name))).toEqual(
      [],
    );
  });

  test("new hidden mutating tool fails the guard instead of silently gaining reset coverage", () => {
    const registry = new ToolRegistryClass();
    registry.registerDeviceAware("newMutation", "x", z.object({}), async () => ({ content: [] }), {
      hidden: true,
    });
    expect(mutationToolCoverageViolations(registry.getEveryRegisteredTool())).toEqual([
      "newMutation: missing journaled adapter, pending-adapter or explicit notJournaled justification",
    ]);
  });

  test("mixed tools are controls for coverage while unconditional reads are excluded", () => {
    expect(
      mutationToolCoverageViolations([
        {
          name: "newMixedTool",
          requiresDevice: true,
          deviceReadOnly: (args) => args.action === "get",
        },
        { name: "pureRead", requiresDevice: true, deviceReadOnly: true },
      ]),
    ).toEqual([
      "newMixedTool: missing journaled adapter, pending-adapter or explicit notJournaled justification",
    ]);
  });

  test("journaled adapters, pending device adapters and host-only exemptions are distinct", () => {
    expect(DEVICE_MUTATION_TOOL_COVERAGE.clipboard.status).toBe("journaled");
    expect(DEVICE_MUTATION_TOOL_COVERAGE.setPreference.status).toBe("journaled");
    expect(DEVICE_MUTATION_TOOL_COVERAGE.stageSessionDownloads.status).toBe("pending-adapter");
    expect(DEVICE_MUTATION_TOOL_COVERAGE.setActiveDevice.status).toBe("notJournaled");
    expect(
      mutationToolCoverageViolations([{ name: "clipboard" }], {
        clipboard: { status: "pending-adapter", reason: " " },
      }),
    ).toHaveLength(1);
  });

  test.each(["persona", "statusBar", "sendBroadcast", "measureStartup"])(
    "%s stays pending until a production mutation adapter is exercised",
    (name) => {
      expect(DEVICE_MUTATION_TOOL_COVERAGE[name].status).toBe("pending-adapter");
      expect(DEVICE_MUTATION_TOOL_COVERAGE[name].reason).toContain("best-effort");
    },
  );

  test.each(["getLogs", "compareScreenshot"])("%s is unconditionally read-only", (name) => {
    const tool = ToolRegistry.getEveryRegisteredTool().find((entry) => entry.name === name);
    expect(tool?.deviceReadOnly).toBe(true);
  });

  test("pending mutation coverage is not a keep-booted admission gate", () => {
    const pending = Object.values(DEVICE_MUTATION_TOOL_COVERAGE).filter(
      (entry) => entry.status === "pending-adapter",
    );
    expect(pending.length).toBeGreaterThan(0);
    for (const entry of pending) {
      expect(entry.reason).not.toMatch(/never evidence of a clean reset|require fallback/i);
    }
  });
});
