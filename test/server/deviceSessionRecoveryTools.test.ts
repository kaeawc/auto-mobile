import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEVICE_SESSION_ACQUISITION_TOOLS,
  DEVICE_SESSION_RECOVERY_PROMPT,
  DEVICE_SESSION_RECOVERY_TOOLS,
} from "../../src/server/deviceSessionResult";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerDeviceTools } from "../../src/server/deviceTools";

/**
 * Every `session_ownership_lost` / `no_active_device_session` payload tells the
 * client which tools acquire a replacement session. That advice is only useful
 * for tools the client can actually discover: `startDevice` is registered
 * `hidden: true`, so it never appears in `tools/list` and is not
 * user-configurable either. This pins the advertised set to the registry so the
 * two cannot drift again.
 */
describe("advertised device-session recovery tools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerDeviceTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("matches the acquisition tools a client can discover", () => {
    const discoverable = DEVICE_SESSION_ACQUISITION_TOOLS.filter(
      (name) =>
        ToolRegistry.isUserConfigurableTool(name) &&
        ToolRegistry.getRegisteredTool(name)?.defaultEnabled === true,
    );
    expect([...DEVICE_SESSION_RECOVERY_TOOLS]).toEqual([...discoverable]);
  });

  test("excludes acquisition tools that are not enabled on a default connection", () => {
    // A default connection omits `defaultEnabled: false` tools from discovery
    // AND rejects the call, so advertising one hands the client dead advice.
    for (const name of DEVICE_SESSION_RECOVERY_TOOLS) {
      expect(ToolRegistry.getRegisteredTool(name)?.defaultEnabled).toBe(true);
    }
    expect(ToolRegistry.getRegisteredTool("provisionDevice")?.defaultEnabled).toBe(false);
    expect([...DEVICE_SESSION_RECOVERY_TOOLS]).not.toContain("provisionDevice");
  });

  test("excludes the hidden startDevice tool", () => {
    expect(ToolRegistry.isUserConfigurableTool("startDevice")).toBe(false);
    expect([...DEVICE_SESSION_RECOVERY_TOOLS]).not.toContain("startDevice");
  });

  test("every advertised tool is a registered acquisition tool", () => {
    for (const name of DEVICE_SESSION_RECOVERY_TOOLS) {
      expect([...DEVICE_SESSION_ACQUISITION_TOOLS]).toContain(name);
      expect(ToolRegistry.getRegisteredTool(name)).toBeDefined();
    }
  });

  test("the prose prompt names exactly the advertised tools", () => {
    for (const name of DEVICE_SESSION_RECOVERY_TOOLS) {
      expect(DEVICE_SESSION_RECOVERY_PROMPT).toContain(name);
    }
    expect(DEVICE_SESSION_RECOVERY_PROMPT).not.toContain("startDevice");
    expect(DEVICE_SESSION_RECOVERY_PROMPT).toMatch(/to acquire a new device session\.$/);
  });
});
