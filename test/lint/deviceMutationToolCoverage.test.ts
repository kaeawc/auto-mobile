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
      "newMutation: missing journaled adapter or explicit notJournaled justification",
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
    ).toEqual(["newMixedTool: missing journaled adapter or explicit notJournaled justification"]);
  });

  test("journaled adapters and notJournaled justifications are distinct, and nothing is left pending", () => {
    expect(DEVICE_MUTATION_TOOL_COVERAGE.clipboard.status).toBe("journaled");
    expect(DEVICE_MUTATION_TOOL_COVERAGE.stageSessionDownloads.status).toBe("journaled");
    expect(DEVICE_MUTATION_TOOL_COVERAGE.setActiveDevice.status).toBe("notJournaled");
    for (const [name, entry] of Object.entries(DEVICE_MUTATION_TOOL_COVERAGE)) {
      expect({ name, status: entry.status }).toEqual({
        name,
        status: expect.stringMatching(/^(journaled|notJournaled)$/),
      });
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
    expect(
      mutationToolCoverageViolations([{ name: "clipboard" }], {
        clipboard: { status: "journaled", reason: " " },
      }),
    ).toHaveLength(1);
  });

  test.each([
    "sendBroadcast",
    "backgroundWork",
    "launchApp",
    "measureStartup",
    "installApp",
    "uninstallApp",
    "executePlan",
    "setDeviceResources",
    "reconcileDeviceResources",
    "prototype",
    "setDeviceState",
    "deviceSnapshot",
  ])("%s can record an escalating fallback intent and says so", (name) => {
    expect(DEVICE_MUTATION_TOOL_COVERAGE[name]).toMatchObject({
      status: "journaled",
      fallback: true,
    });
  });

  test("only journaled tools may claim a fallback intent", () => {
    for (const [name, entry] of Object.entries(DEVICE_MUTATION_TOOL_COVERAGE)) {
      expect({ name, ok: entry.fallback === undefined || entry.status === "journaled" }).toEqual({
        name,
        ok: true,
      });
    }
  });

  test.each(["getLogs", "compareScreenshot"])("%s is unconditionally read-only", (name) => {
    const tool = ToolRegistry.getEveryRegisteredTool().find((entry) => entry.name === name);
    expect(tool?.deviceReadOnly).toBe(true);
  });
});
