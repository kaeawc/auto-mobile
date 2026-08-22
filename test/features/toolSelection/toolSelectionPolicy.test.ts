import { describe, expect, test } from "bun:test";
import type { SessionToolSelectionService } from "../../../src/features/toolSelection/SessionToolSelectionService";
import {
  assertToolEnabledForAnySession,
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

  test("reports the exact disabled tool rather than a capability group", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    await expect(
      assertToolEnabledForAnySession("selectAllText", false, ["session-1"], disabled),
    ).rejects.toThrow("Tool selectAllText is disabled");
  });
});
