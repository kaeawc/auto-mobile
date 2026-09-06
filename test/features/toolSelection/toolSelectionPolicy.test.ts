import { describe, expect, test } from "bun:test";
import type { SessionToolSelectionService } from "../../../src/features/toolSelection/SessionToolSelectionService";
import {
  assertToolEnabledForAnySession,
  assertToolEnabledForSession,
  isToolEnabledForAnyRoute,
  isToolEnabledForAnySession,
} from "../../../src/features/toolSelection/toolSelectionPolicy";
import { IDE_SET_SESSION_TOOL_ENABLED_METHOD } from "../../../src/features/toolSelection/toolSelectionControl";

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

  test("assertToolEnabledForSession omits sessionUuid when unbound rather than naming the display placeholder", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    await expect(
      assertToolEnabledForSession("systemTray", false, undefined, disabled),
    ).rejects.toThrow(
      'Tool systemTray is disabled for device session (not yet bound). Enable it with setToolEnabled { toolName: "systemTray", enabled: true }.',
    );
  });

  test("assertToolEnabledForAnySession instructs acquiring a session instead of advertising a sessionless remediation when unbound on the IDE-socket channel (PRRT_kwDOP-GF5M6fucGA)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    // Zero candidates and no connectionProfileUuid on the IDE-socket channel (e.g.
    // assertSocketToolEnabled against a booted device with no owning daemon session): that
    // channel has no MCP connection profile to create, so a sessionless remediation would mint
    // a new one the retry (ide/setKeyValue etc.) never rechecks, and the tool would stay
    // disabled. There is nothing to advertise — tell the caller to acquire a session first.
    await expect(
      assertToolEnabledForAnySession(
        "systemTray",
        false,
        [undefined],
        disabled,
        undefined,
        IDE_SET_SESSION_TOOL_ENABLED_METHOD,
      ),
    ).rejects.toThrow(
      "Tool systemTray is disabled for device session (not yet bound). " +
        "No device session owns this device yet, so there is nothing ide/setSessionToolEnabled could enable " +
        "that a retry would recheck. Acquire a device session with getAndroid { deviceId } " +
        "(or getApple { deviceId }), then enable the tool with " +
        'ide/setSessionToolEnabled { toolName: "systemTray", enabled: true, sessionUuid: "<uuid from getAndroid/getApple>" }.',
    );
    await expect(
      assertToolEnabledForAnySession(
        "systemTray",
        false,
        [],
        disabled,
        undefined,
        IDE_SET_SESSION_TOOL_ENABLED_METHOD,
      ),
    ).rejects.toThrow(/Acquire a device session with getAndroid \{ deviceId \}/);
  });

  test("assertToolEnabledForAnySession advertises sessionless setToolEnabled (not device acquisition) for a fresh MCP connection with no sessionUuid and no profile yet (issue #6259)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    // Zero candidates and no connectionProfileUuid on the default (MCP) channel: this is a
    // brand-new MCP connection that has never called setToolEnabled. src/server/index.ts:512-536
    // creates the connection profile the FIRST time setToolEnabled is called sessionless, so —
    // unlike the IDE-socket channel above — the sessionless form is real remediation here, even
    // for a non-device tool. Device acquisition is not required just to enable the tool.
    await expect(
      assertToolEnabledForAnySession("debugSearch", false, [undefined], disabled),
    ).rejects.toThrow(
      "Tool debugSearch is disabled for device session (not yet bound). " +
        'Enable it with setToolEnabled { toolName: "debugSearch", enabled: true }.',
    );
    await expect(
      assertToolEnabledForAnySession("debugSearch", false, [], disabled),
    ).rejects.toThrow('Enable it with setToolEnabled { toolName: "debugSearch", enabled: true }.');
  });

  test("assertToolEnabledForAnySession omits sessionUuid across composite connection/base/label profiles when a connection profile is actually rechecked (PRRT_kwDOP-GF5M6fuHM5)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    // The MCP-server path (src/server/index.ts) always passes its `connectionProfileUuid` as
    // the 5th arg, so the omitted-sessionUuid remediation lands on a profile the retry actually
    // rechecks.
    await expect(
      assertToolEnabledForAnySession(
        "systemTray",
        false,
        ["connection", "base", "base:label"],
        disabled,
        "connection",
      ),
    ).rejects.toThrow(
      "Tool systemTray is disabled for device session connection / base / base:label. " +
        'Enable it with setToolEnabled { toolName: "systemTray", enabled: true }.',
    );
  });

  test("assertToolEnabledForAnySession names the first (base-preferring) candidate rather than the connection-profile form when no connection profile is rechecked (PRRT_kwDOP-GF5M6fuRKy — socket gate)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    // The IDE socket-gate path (`assertSocketToolEnabled` in src/daemon/socketServer.ts) never
    // has a connection profile — it rechecks only [baseSessionUuid, derivedSessionUuid]. Omitting
    // sessionUuid there would create/enable an unrelated MCP connection profile that the retry
    // never looks at, so the remediation must name a real profile the gate rechecks instead —
    // the first (base) candidate.
    await expect(
      assertToolEnabledForAnySession(
        "setKeyValue",
        false,
        ["base-session", "base-session:label"],
        disabled,
      ),
    ).rejects.toThrow(
      'Enable it with setToolEnabled { toolName: "setKeyValue", enabled: true, sessionUuid: "base-session" }.',
    );
  });

  test("assertSocketToolEnabled's IDE-socket rejection names ide/setSessionToolEnabled, never the MCP setToolEnabled tool (issue #6259, PRRT_kwDOP-GF5M6fumZY)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    // A caller on the direct IDE socket channel (src/daemon/socketServer.ts
    // `assertSocketToolEnabled`) cannot invoke an MCP tool — only the socket's own
    // `ide/setSessionToolEnabled` method (src/daemon/socketServer.ts:2418-2444), which requires
    // sessionUuid, toolName, and enabled params.
    await expect(
      assertToolEnabledForAnySession(
        "setKeyValue",
        false,
        ["base-session", "base-session:label"],
        disabled,
        undefined,
        IDE_SET_SESSION_TOOL_ENABLED_METHOD,
      ),
    ).rejects.toThrow(
      'Enable it with ide/setSessionToolEnabled { toolName: "setKeyValue", enabled: true, sessionUuid: "base-session" }.',
    );
  });

  test("the MCP tool-dispatch rejection still names the MCP setToolEnabled tool (issue #6259)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    // src/server/index.ts calls assertToolEnabledForAnySession without a remediationMethodName,
    // so the MCP channel keeps naming the `setToolEnabled` MCP tool.
    await expect(
      assertToolEnabledForAnySession("setKeyValue", false, ["base-session"], disabled),
    ).rejects.toThrow(
      'Enable it with setToolEnabled { toolName: "setKeyValue", enabled: true, sessionUuid: "base-session" }.',
    );
  });

  test("assertToolEnabledForAnySession names the sole candidate even without a connection profile", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    await expect(
      assertToolEnabledForAnySession("setKeyValue", false, ["derived-only"], disabled),
    ).rejects.toThrow(
      'Enable it with setToolEnabled { toolName: "setKeyValue", enabled: true, sessionUuid: "derived-only" }.',
    );
  });

  test("assertToolEnabledForAnySession omits sessionUuid (rather than instructing session acquisition) when a connectionProfileUuid is rechecked even with zero routing candidates (PRRT_kwDOP-GF5M6fucGA)", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    // A connectionProfileUuid means the retry DOES recheck a real profile — the connection
    // one — even though no base/derived session candidates are known, so the omitted-sessionUuid
    // form (which targets the connection profile) still works and must be preferred over the
    // "acquire a session" message.
    await expect(
      assertToolEnabledForAnySession("observe", true, [], disabled, "connection"),
    ).rejects.toThrow('Enable it with setToolEnabled { toolName: "observe", enabled: true }.');
  });

  test("assertToolEnabledForAnySession names the sole real candidate session uuid, matching resolveSelectionSessionUuid's accepted values", async () => {
    const disabled: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    // A single resolvable candidate (e.g. duplicate connection/routing uuids collapsing via
    // the Set dedupe) is the one case where the advertised sessionUuid must equal what
    // resolveSelectionSessionUuid (src/server/toolSelectionTools.ts) would accept: the
    // caller's own connection or routing profile uuid, never a joined display string.
    await expect(
      assertToolEnabledForAnySession("systemTray", false, ["session-abc", "session-abc"], disabled),
    ).rejects.toThrow(
      'Enable it with setToolEnabled { toolName: "systemTray", enabled: true, sessionUuid: "session-abc" }.',
    );
  });
});
