import { describe, expect, test } from "bun:test";
import {
  resolveCapabilityBaseSessionUuid,
  type CapabilitySessionManager,
} from "../../../src/features/toolCapabilities/capabilitySessionResolver";
import {
  assertToolEnabledForAnySession,
  isToolEnabledForAnySession,
} from "../../../src/features/toolCapabilities/toolCapabilityPolicy";
import type { SessionToolProfileService } from "../../../src/features/toolCapabilities/SessionToolProfileService";

const labeledSessionManager: CapabilitySessionManager = {
  getDeviceLabels: sessionUuid =>
    sessionUuid === "base-session"
      ? { A: "base-session", B: "base-session:B" }
      : undefined,
};

describe("resolveCapabilityBaseSessionUuid", () => {
  test("returns a derived label session's base session", () => {
    expect(resolveCapabilityBaseSessionUuid("base-session:B", labeledSessionManager)).toBe("base-session");
  });

  test("returns a plain base session unchanged", () => {
    expect(resolveCapabilityBaseSessionUuid("base-session", labeledSessionManager)).toBe("base-session");
  });

  test("returns the input unchanged when the label cannot be resolved", () => {
    expect(resolveCapabilityBaseSessionUuid("unknown:X", labeledSessionManager)).toBe("unknown:X");
  });

  test("passes through when no session manager is available", () => {
    expect(resolveCapabilityBaseSessionUuid("base-session:B", undefined)).toBe("base-session:B");
  });

  test("passes through undefined", () => {
    expect(resolveCapabilityBaseSessionUuid(undefined, labeledSessionManager)).toBeUndefined();
  });
});

describe("isToolEnabledForAnySession (union semantics)", () => {
  const only = (enabledSession: string): Pick<SessionToolProfileService, "isEnabled"> => ({
    isEnabled: async sessionUuid => sessionUuid === enabledSession,
  });

  test("non-capability tools are always enabled", async () => {
    expect(await isToolEnabledForAnySession("observe", [undefined], only("x"))).toBe(true);
  });

  test("uses the core default when no session is bound", async () => {
    expect(await isToolEnabledForAnySession("clipboard", [undefined, undefined], only("x"))).toBe(false);
  });

  test("enabled when only the base session grants it", async () => {
    expect(await isToolEnabledForAnySession("clipboard", ["base", "base:B"], only("base"))).toBe(true);
  });

  test("enabled when only the derived session grants it", async () => {
    expect(await isToolEnabledForAnySession("clipboard", ["base", "base:B"], only("base:B"))).toBe(true);
  });

  test("disabled only when neither base nor derived grants it", async () => {
    const noneEnabled: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled: async () => false };
    expect(await isToolEnabledForAnySession("clipboard", ["base", "base:B"], noneEnabled)).toBe(false);
  });

  test("an explicit connection disable overrides routing defaults but not a routing opt-in", async () => {
    const overrides = new Map<string, boolean | undefined>([
      ["connection", false],
      ["base", undefined],
      ["base:B", undefined],
    ]);
    const profileService: Pick<SessionToolProfileService, "isEnabled" | "getOverride"> = {
      isEnabled: async sessionUuid => sessionUuid !== "connection",
      getOverride: async sessionUuid => overrides.get(sessionUuid),
    };

    expect(await isToolEnabledForAnySession(
      "clipboard",
      ["connection", "base", "base:B"],
      profileService,
      "connection",
    )).toBe(false);

    overrides.set("base:B", true);
    expect(await isToolEnabledForAnySession(
      "clipboard",
      ["connection", "base", "base:B"],
      profileService,
      "connection",
    )).toBe(true);
  });
});

describe("assertToolEnabledForAnySession", () => {
  test("throws naming the capability when both sessions narrow it away", async () => {
    const noneEnabled: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled: async () => false };
    await expect(assertToolEnabledForAnySession("clipboard", ["base", "base:B"], noneEnabled))
      .rejects.toThrow("requires the 'clipboard' capability");
  });

  test("resolves when either session grants the capability", async () => {
    const derivedEnabled: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async sessionUuid => sessionUuid === "base:B",
    };
    await expect(assertToolEnabledForAnySession("clipboard", ["base", "base:B"], derivedEnabled))
      .resolves.toBeUndefined();
  });
});
