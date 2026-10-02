import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { getToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { executionTracker } from "../../src/server/executionTracker";
import { AdmittingAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { permissiveDeviceAdmissionGate } from "../../src/daemon/deviceAdmissionGate";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";

const TOOL = "__device_binding_probe_6929__";
const SERIAL = "emulator-5554";

describe("MCP ingress device execution binding", () => {
  let fixture: McpTestFixture;
  let restore: () => void;
  let bound = false;
  let sessionUuid: string | undefined;

  beforeAll(async () => {
    restore = installHermeticServerFixture();
    const factory = new AdmittingAdbClientFactory(new FakeAdbClientFactory(), {
      admissionGate: permissiveDeviceAdmissionGate,
    });
    ToolRegistry.register(TOOL, "sessionless device binding probe", z.object({}), async () => {
      sessionUuid = getToolSelectionContext()?.routingSessionUuid;
      factory.create({ deviceId: SERIAL, name: "Pixel", platform: "android" });
      bound = executionTracker.hasActiveDeviceExecutions(SERIAL);
      return createStructuredToolResponse({ success: true });
    });
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    await fixture.teardown();
    ToolRegistry["tools"].delete(TOOL);
    restore();
  });

  test("the real CallTool handler binds a sessionless execution and cleans it on return", async () => {
    await fixture.client.callTool({ name: TOOL, arguments: {} });
    expect(sessionUuid).toBeUndefined();
    expect(bound).toBe(true);
    expect(executionTracker.hasActiveDeviceExecutions(SERIAL)).toBe(false);
  });
});
