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

  test("every mutating registry tool including mixed, hidden and SDK tools has a pending adapter justification", () => {
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
      "newMutation: missing pending-adapter or explicit notJournaled justification",
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
    ).toEqual(["newMixedTool: missing pending-adapter or explicit notJournaled justification"]);
  });

  test("pending device adapters and host-only notJournaled exemptions are distinct", () => {
    expect(DEVICE_MUTATION_TOOL_COVERAGE.clipboard.status).toBe("pending-adapter");
    expect(DEVICE_MUTATION_TOOL_COVERAGE.setActiveDevice.status).toBe("notJournaled");
    expect(
      mutationToolCoverageViolations([{ name: "clipboard" }], {
        clipboard: { status: "pending-adapter", reason: " " },
      }),
    ).toHaveLength(1);
  });
});
