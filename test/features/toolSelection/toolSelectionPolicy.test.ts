import { describe, expect, test } from "bun:test";
import type { SessionToolSelectionService } from "../../../src/features/toolSelection/SessionToolSelectionService";
import {
  assertToolEnabledForAnySession,
  assertToolEnabledForSession,
  isToolEnabledForAnyRoute,
  isToolEnabledForAnySession,
} from "../../../src/features/toolSelection/toolSelectionPolicy";

describe("exact-tool selection union policy", () => {
  const only = (enabledSession: string): Pick<SessionToolSelectionService, "isEnabled"> => ({
    isEnabled: async (sessionUuid, _toolName, declaredDefault) =>
      sessionUuid === undefined ? declaredDefault : sessionUuid === enabledSession,
  });

  test("uses the registered tool default before a session binds", async () => {
    expect(await isToolEnabledForAnySession("observe", true, [undefined], only("x"))).toBe(true);
    expect(await isToolEnabledForAnySession("clipboard", false, [undefined], only("x"))).toBe(
      false,
    );
  });

  test("enables when either the base or derived session grants the exact tool", async () => {
    expect(
      await isToolEnabledForAnySession("clipboard", false, ["base", "base:B"], only("base:B")),
    ).toBe(true);
  });

  test("a connection disable overrides inherited defaults but not an explicit routing enable", async () => {
    const overrides = new Map<string, boolean | undefined>([
      ["connection", false],
      ["base", undefined],
      ["base:B", undefined],
    ]);
    const service: Pick<SessionToolSelectionService, "isEnabled" | "getOverride"> = {
      isEnabled: async (_sessionUuid, _toolName, declaredDefault) => declaredDefault,
      getOverride: async (sessionUuid) => overrides.get(sessionUuid),
    };

    expect(
      await isToolEnabledForAnySession(
        "observe",
        true,
        ["connection", "base", "base:B"],
        service,
        "connection",
      ),
    ).toBe(false);

    overrides.set("base:B", true);
    expect(
      await isToolEnabledForAnySession(
        "observe",
        true,
        ["connection", "base", "base:B"],
        service,
        "connection",
      ),
    ).toBe(true);
  });

  test("an unset connection profile does not override an explicit routing disable", async () => {
    const overrides = new Map<string, boolean>([["routing", false]]);
    const service: Pick<SessionToolSelectionService, "isEnabled" | "getOverride"> = {
      isEnabled: async (sessionUuid, _toolName, declaredDefault) =>
        (sessionUuid ? overrides.get(sessionUuid) : undefined) ?? declaredDefault,
      getOverride: async (sessionUuid) => overrides.get(sessionUuid),
    };

    expect(
      await isToolEnabledForAnySession(
        "observe",
        true,
        ["connection", "routing"],
        service,
        "connection",
      ),
    ).toBe(false);
    expect(
      await isToolEnabledForAnySession("observe", true, ["connection"], service, "connection"),
    ).toBe(true);
  });

  test("routing sessions resolve explicit choices before inherited defaults", async () => {
    const overrides = new Map<string, boolean>([["base:B", false]]);
    const service: Pick<SessionToolSelectionService, "isEnabled" | "getOverride"> = {
      isEnabled: async (sessionUuid, _toolName, declaredDefault) =>
        (sessionUuid ? overrides.get(sessionUuid) : undefined) ?? declaredDefault,
      getOverride: async (sessionUuid) => overrides.get(sessionUuid),
    };
    const candidates = ["connection", "base", "base:B"];

    expect(
      await isToolEnabledForAnySession("observe", true, candidates, service, "connection"),
    ).toBe(false);

    overrides.set("base", true);
    expect(
      await isToolEnabledForAnySession("observe", true, candidates, service, "connection"),
    ).toBe(true);

    overrides.clear();
    expect(
      await isToolEnabledForAnySession("observe", true, candidates, service, "connection"),
    ).toBe(true);
  });

  test("unions independent sibling-label routes without sharing their disables", async () => {
    const overrides = new Map<string, boolean>([["base:A", false]]);
    const service: Pick<SessionToolSelectionService, "isEnabled" | "getOverride"> = {
      isEnabled: async (sessionUuid, _toolName, declaredDefault) =>
        (sessionUuid ? overrides.get(sessionUuid) : undefined) ?? declaredDefault,
      getOverride: async (sessionUuid) => overrides.get(sessionUuid),
    };
    const routes = [
      ["base", "base:A"],
      ["base", "base:B"],
    ];

    expect(
      await isToolEnabledForAnySession(
        "observe",
        true,
        ["connection", ...routes[0]],
        service,
        "connection",
      ),
    ).toBe(false);
    expect(
      await isToolEnabledForAnySession(
        "observe",
        true,
        ["connection", ...routes[1]],
        service,
        "connection",
      ),
    ).toBe(true);
    expect(await isToolEnabledForAnyRoute("observe", true, routes, service, "connection")).toBe(
      true,
    );

    overrides.set("base:B", false);
    expect(await isToolEnabledForAnyRoute("observe", true, routes, service, "connection")).toBe(
      false,
    );

    overrides.set("base:B", true);
    expect(await isToolEnabledForAnyRoute("observe", true, routes, service, "connection")).toBe(
      true,
    );

    overrides.clear();
    overrides.set("connection", false);
    expect(await isToolEnabledForAnyRoute("observe", true, routes, service, "connection")).toBe(
      false,
    );

    overrides.set("base:B", true);
    expect(await isToolEnabledForAnyRoute("observe", true, routes, service, "connection")).toBe(
      true,
    );
  });

  test("reports the exact disabled tool rather than a capability group", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    await expect(
      assertToolEnabledForAnySession("selectAllText", false, ["session-1"], disabled),
    ).rejects.toThrow("Tool selectAllText is disabled");
  });

  test("names the setToolEnabled call with the interpolated tool and session (issue #6259)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    await expect(
      assertToolEnabledForAnySession("systemTray", false, ["session-abc"], disabled),
    ).rejects.toThrow(
      'Enable it with setToolEnabled { toolName: "systemTray", enabled: true, sessionUuid: "session-abc" }.',
    );
  });

  test("assertToolEnabledForSession also names the setToolEnabled remediation (issue #6259)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    await expect(
      assertToolEnabledForSession("systemTray", false, "session-abc", disabled),
    ).rejects.toThrow(
      'Enable it with setToolEnabled { toolName: "systemTray", enabled: true, sessionUuid: "session-abc" }.',
    );
  });
});
