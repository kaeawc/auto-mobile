import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerUtilityTools } from "../../src/server/utilityTools";
import {
  getActiveDeviceSelectionFromResult,
  getDeviceSessionIdFromResult,
} from "../../src/server/deviceSessionResult";

/**
 * Ergonomics fixes for the device-acquisition workflow (issue #5870).
 *
 * These pin the advertised-schema shape a client sees in `tools/list`:
 * a field with a default is never advertised as required, and `platform`
 * drops out of `required` on tools that also accept a `sessionUuid`
 * (the session resolves the platform). Also pins the acquisition tools'
 * result session key (`sessionUuid`) that consumer tools' params declare.
 */
describe("device acquisition ergonomics (#5870)", () => {
  function advertisedInputSchema(name: string): {
    required?: string[];
    properties?: Record<string, unknown>;
  } {
    const def = ToolRegistry.getToolDefinitions().find((tool) => tool.name === name);
    if (!def) {
      throw new Error(`${name} is not registered`);
    }
    return def.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
  }

  describe("advertised schema required-field ergonomics", () => {
    beforeEach(() => {
      ToolRegistry.clearTools();
      registerInteractionTools();
      registerUtilityTools();
    });

    afterEach(() => {
      ToolRegistry.clearTools();
    });

    test("tapOn does not advertise `action` as required (it has a default)", () => {
      const schema = advertisedInputSchema("tapOn");
      expect(schema.properties).toHaveProperty("action");
      expect(schema.required ?? []).not.toContain("action");
    });

    test("tapOn does not advertise `platform` as required (sessionUuid resolves it)", () => {
      const schema = advertisedInputSchema("tapOn");
      expect(schema.required ?? []).not.toContain("platform");
    });

    test("setActiveDevice does not advertise `platform` as required", () => {
      const schema = advertisedInputSchema("setActiveDevice");
      expect(schema.required ?? []).not.toContain("platform");
    });
  });

  describe("getDeviceSessionIdFromResult reads the canonical key", () => {
    const envelope = (payload: Record<string, unknown>) => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    test("reads `runtime.session.sessionUuid` from an acquisition result", () => {
      expect(
        getDeviceSessionIdFromResult(
          envelope({ runtime: { session: { sessionUuid: "abc-123" } } }),
        ),
      ).toBe("abc-123");
    });

    test("reads provisionDevice's envelope `sessionId`", () => {
      expect(getDeviceSessionIdFromResult(envelope({ sessionId: "provision-9" }))).toBe(
        "provision-9",
      );
    });

    test("setActiveDevice's top-level sessionUuid is not an acquisition session", () => {
      expect(
        getDeviceSessionIdFromResult(envelope({ deviceId: "emulator-5554", sessionUuid: "s1" })),
      ).toBeUndefined();
    });
  });

  describe("getActiveDeviceSelectionFromResult reads setActiveDevice's payload (#11235)", () => {
    const envelope = (payload: Record<string, unknown>) => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    test("reads the selected session and device", () => {
      expect(
        getActiveDeviceSelectionFromResult(
          envelope({ message: "Active device set", deviceId: "emulator-5554", sessionUuid: "s1" }),
        ),
      ).toEqual({ sessionUuid: "s1", deviceId: "emulator-5554" });
    });

    test("is undefined when no session was selected", () => {
      expect(
        getActiveDeviceSelectionFromResult(envelope({ deviceId: "emulator-5554" })),
      ).toBeUndefined();
    });
  });
});
