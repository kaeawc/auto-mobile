import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { z } from "zod/v4";
import {
  SessionToolSelectionService,
  type SessionToolSelectionRepository,
} from "../../src/features/toolSelection/SessionToolSelectionService";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  getAndroidSchema,
  getAppleSchema,
  provisionDeviceSchema,
} from "../../src/server/deviceTools";
import {
  registerToolSelectionTools,
  SET_TOOL_ENABLED_TOOL_NAME,
  setToolEnabledSchema,
} from "../../src/server/toolSelectionTools";

/**
 * #6869 — `setToolEnabled` accepted a single `toolName`, so declaring the
 * toolset for one task cost one round-trip per tool, and its
 * `{sessionUuid, toolName, enabled}` result never showed the resulting enabled
 * set. `toolNames: string[]` is the batch spelling; `enabledTools` is the
 * confirmation. The single-name request and its three existing result fields
 * are unchanged.
 */

class FakeRepository implements SessionToolSelectionRepository {
  readonly rows = new Map<string, Map<string, boolean>>();
  /** Every (sessionUuid, toolName, enabled) the repository was asked to persist. */
  readonly writes: Array<[string, string, boolean]> = [];
  /** Each batch as the repository received it — one entry per transactional write. */
  readonly batches: Array<Array<[string, string, boolean]>> = [];
  /** When set, `setMany` rejects with it AFTER staging nothing (see #6886 review). */
  failBatchWith: Error | undefined;
  /** When set, reporting the enabled set rejects after a successful write. */
  failListWith: Error | undefined;

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
    if (this.failListWith) {
      throw this.failListWith;
    }
    return new Map(this.rows.get(sessionUuid) ?? []);
  }

  async set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void> {
    this.writes.push([sessionUuid, toolName, enabled]);
    this.batches.push([[sessionUuid, toolName, enabled]]);
    const values = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    values.set(toolName, enabled);
    this.rows.set(sessionUuid, values);
  }

  async setMany(
    sessionUuid: string,
    entries: ReadonlyArray<{ toolName: string; enabled: boolean }>,
  ): Promise<void> {
    if (this.failBatchWith) {
      throw this.failBatchWith;
    }
    const values = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    this.batches.push(
      entries.map((entry) => {
        this.writes.push([sessionUuid, entry.toolName, entry.enabled]);
        values.set(entry.toolName, entry.enabled);
        return [sessionUuid, entry.toolName, entry.enabled] as [string, string, boolean];
      }),
    );
    this.rows.set(sessionUuid, values);
  }

  async deleteSession(sessionUuid: string): Promise<void> {
    this.rows.delete(sessionUuid);
  }
}

const SESSION_UUID = "session-6869";
const PROFILE_UUID = "connection-profile-6869";

describe("setToolEnabled batch enable (#6869)", () => {
  let repository: FakeRepository;
  let service: SessionToolSelectionService;

  const callSetToolEnabled = async (
    args: Record<string, unknown>,
    context: { toolSelectionProfileUuid?: string } = {},
  ): Promise<any> => {
    const tool = ToolRegistry.getTool(SET_TOOL_ENABLED_TOOL_NAME)!;
    const parsed = tool.schema.parse(args);
    return await runWithToolSelectionContext(
      { routingSessionUuid: SESSION_UUID, sessionToolSelectionService: service, ...context },
      () => tool.handler(parsed),
    );
  };

  const payloadOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    JSON.parse(result.content.find((item) => item.type === "text")!.text!);

  beforeEach(() => {
    repository = new FakeRepository();
    service = new SessionToolSelectionService(repository);
    ToolRegistry.clearTools();
    for (const [name, defaultEnabled] of [
      ["inputText", false],
      ["clearText", false],
      ["imeAction", false],
      ["observe", true],
    ] as const) {
      ToolRegistry.register(
        name,
        name,
        z.object({ sessionUuid: z.string().optional() }),
        async () => ({ content: [{ type: "text" as const, text: name }] }),
        { defaultEnabled },
      );
    }
    registerToolSelectionTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("the single-name request and its three existing result fields are unchanged", async () => {
    const payload = payloadOf(await callSetToolEnabled({ toolName: "inputText" }));

    expect(payload.sessionUuid).toBe(SESSION_UUID);
    expect(payload.toolName).toBe("inputText");
    expect(payload.enabled).toBe(true);
    expect(payload.toolNames).toBeUndefined();
    expect(repository.writes).toEqual([[SESSION_UUID, "inputText", true]]);
  });

  test("enables every name in toolNames in one call", async () => {
    const payload = payloadOf(
      await callSetToolEnabled({ toolNames: ["inputText", "clearText", "imeAction"] }),
    );

    expect(payload.toolNames).toEqual(["inputText", "clearText", "imeAction"]);
    expect(payload.toolName).toBeUndefined();
    expect(payload.enabled).toBe(true);
    expect(repository.writes).toEqual([
      [SESSION_UUID, "inputText", true],
      [SESSION_UUID, "clearText", true],
      [SESSION_UUID, "imeAction", true],
    ]);
  });

  test("returns the resulting enabled set for the session", async () => {
    const payload = payloadOf(await callSetToolEnabled({ toolNames: ["inputText", "clearText"] }));

    // `observe` is enabled by its declared default; `imeAction` stays gated.
    expect(payload.enabledTools).toEqual(["clearText", "inputText", "observe"]);
  });

  test("reports the enabled set after a disable too", async () => {
    const payload = payloadOf(await callSetToolEnabled({ toolNames: ["observe"], enabled: false }));

    expect(payload.enabled).toBe(false);
    expect(payload.enabledTools).toEqual([]);
  });

  // #6886 review — `tools/list` and the call gate resolve a tool against the
  // UNION of the connection profile and the routing session, so reporting
  // `enabledTools` from the updated UUID alone omitted tools that stay callable.
  // A sessionless update after `getAndroid({ enableTools: ["inputText"] })` is
  // exactly that case: the write lands on the connection profile while the grant
  // lives on the routing session.
  test("reports the union of the connection profile and the routing session", async () => {
    await service.setEnabled(SESSION_UUID, "inputText", true);

    const payload = payloadOf(
      await callSetToolEnabled(
        { toolNames: ["clearText"] },
        { toolSelectionProfileUuid: PROFILE_UUID },
      ),
    );

    expect(payload.sessionUuid).toBe(PROFILE_UUID);
    expect(payload.enabledTools).toEqual(["clearText", "inputText", "observe"]);
  });

  test("reports a tool either side enables, matching the call gate's union", async () => {
    await service.setEnabled(SESSION_UUID, "imeAction", true);

    const payload = payloadOf(
      await callSetToolEnabled(
        { toolNames: ["imeAction"], enabled: false },
        { toolSelectionProfileUuid: PROFILE_UUID },
      ),
    );

    // The routing session still grants it, so the call gate still admits it.
    expect(payload.enabledTools).toContain("imeAction");
  });

  test("rejects an unknown name before writing anything (all-or-nothing)", async () => {
    await expect(
      callSetToolEnabled({ toolNames: ["inputText", "notATool", "clearText"] }),
    ).rejects.toThrow(/notATool/);

    expect(repository.writes).toEqual([]);
  });

  test("keeps the single-name rejection message byte-compatible", async () => {
    await expect(callSetToolEnabled({ toolName: "notATool" })).rejects.toThrow(
      "Tool 'notATool' is not user-configurable.",
    );
  });

  // #6886 review — the advertised all-or-nothing contract has to survive a write
  // failure too, not just an unknown name. One repository operation per batch is
  // what makes that true: SQLite wraps it in a transaction, so a rejection can
  // never leave a prefix of the list applied, and two concurrent batches cannot
  // interleave into a state neither asked for.
  test("persists the whole batch through a single repository operation", async () => {
    await callSetToolEnabled({ toolNames: ["inputText", "clearText", "imeAction"] });

    expect(repository.batches).toEqual([
      [
        [SESSION_UUID, "inputText", true],
        [SESSION_UUID, "clearText", true],
        [SESSION_UUID, "imeAction", true],
      ],
    ]);
  });

  test("leaves nothing applied and does not renotify when the batch write fails", async () => {
    let notifications = 0;
    const restoreNotify = ToolRegistry.notifyToolListChanged.bind(ToolRegistry);
    ToolRegistry.notifyToolListChanged = () => {
      notifications += 1;
    };
    repository.failBatchWith = new Error("selection storage unavailable");

    try {
      await expect(callSetToolEnabled({ toolNames: ["inputText", "clearText"] })).rejects.toThrow(
        "selection storage unavailable",
      );
    } finally {
      ToolRegistry.notifyToolListChanged = restoreNotify;
    }

    expect(repository.writes).toEqual([]);
    expect(repository.rows.get(SESSION_UUID)).toBeUndefined();
    expect(notifications).toBe(0);
  });

  test("reports a read failure after applying the batch", async () => {
    repository.failListWith = new Error("selection read unavailable");

    const payload = payloadOf(await callSetToolEnabled({ toolNames: ["inputText", "clearText"] }));

    expect(repository.writes).toEqual([
      [SESSION_UUID, "inputText", true],
      [SESSION_UUID, "clearText", true],
    ]);
    expect(payload.enabledTools).toBeUndefined();
    expect(payload.enabledToolsError).toContain("selection read unavailable");
  });

  test("applies a repeated name once", async () => {
    await callSetToolEnabled({ toolNames: ["inputText", "inputText"] });

    expect(repository.writes).toEqual([[SESSION_UUID, "inputText", true]]);
  });

  test("writes configurable batch names and reports setToolEnabled as always-on", async () => {
    for (const name of ["rotate", "displayConfig"]) {
      ToolRegistry.register(name, name, z.object({}), async () => ({ content: [] }), {
        defaultEnabled: false,
      });
    }

    const payload = payloadOf(
      await callSetToolEnabled({ toolNames: ["rotate", "displayConfig", "setToolEnabled"] }),
    );

    expect(payload.toolNames).toEqual(["rotate", "displayConfig"]);
    expect(payload.skipped).toEqual([{ toolName: "setToolEnabled", reason: "always-on" }]);
    expect(repository.writes).toEqual([
      [SESSION_UUID, "rotate", true],
      [SESSION_UUID, "displayConfig", true],
    ]);
  });

  test("does not write an entirely always-on batch", async () => {
    const payload = payloadOf(await callSetToolEnabled({ toolNames: ["setToolEnabled"] }));

    expect(payload.toolNames).toEqual([]);
    expect(payload.skipped).toEqual([{ toolName: "setToolEnabled", reason: "always-on" }]);
    expect(repository.writes).toEqual([]);
  });

  describe("schema", () => {
    test("accepts exactly one of toolName and toolNames", () => {
      expect(setToolEnabledSchema.safeParse({ toolName: "inputText" }).success).toBe(true);
      expect(setToolEnabledSchema.safeParse({ toolNames: ["inputText"] }).success).toBe(true);
      expect(
        setToolEnabledSchema.safeParse({ toolName: "inputText", toolNames: ["clearText"] }).success,
      ).toBe(false);
      expect(setToolEnabledSchema.safeParse({ enabled: true }).success).toBe(false);
    });

    test("rejects an empty toolNames array and empty entries", () => {
      expect(setToolEnabledSchema.safeParse({ toolNames: [] }).success).toBe(false);
      expect(setToolEnabledSchema.safeParse({ toolNames: [""] }).success).toBe(false);
    });

    test("advertises the configurable-tool vocabulary on toolNames too", () => {
      const definition = ToolRegistry.getToolDefinitions().find(
        (tool) => tool.name === SET_TOOL_ENABLED_TOOL_NAME,
      )!;
      const properties = definition.inputSchema.properties as Record<string, any>;

      expect(properties.toolName.enum).toEqual(["clearText", "imeAction", "inputText", "observe"]);
      expect(properties.toolNames.items.enum).toEqual(properties.toolName.enum);
    });

    test("advertises the same vocabulary on the acquisition tools' enableTools", () => {
      // #6886 review: `resolveRequestedEnableTools` rejects every unknown or
      // non-configurable name before acquisition, so a schema advertising
      // "any non-empty string" lets a schema-driven client build a call the
      // invocation refuses — and hides the vocabulary of the one-call flow.
      for (const [name, schema] of [
        ["getAndroid", getAndroidSchema],
        ["getApple", getAppleSchema],
        ["provisionDevice", provisionDeviceSchema],
      ] as const) {
        ToolRegistry.register(name, name, schema as any, async () => ({
          content: [{ type: "text" as const, text: name }],
        }));
      }

      const configurable = ["clearText", "imeAction", "inputText", "observe", "provisionDevice"];
      for (const name of ["getAndroid", "getApple", "provisionDevice"]) {
        const definition = ToolRegistry.getToolDefinitions().find((tool) => tool.name === name)!;
        const properties = definition.inputSchema.properties as Record<string, any>;
        expect(properties.enableTools.items.enum).toEqual(configurable);
      }
    });

    test("advertises exactly every registered configurable gated tool and no always-on tools", () => {
      for (const [name, schema] of [
        ["getAndroid", getAndroidSchema],
        ["getApple", getAppleSchema],
        ["provisionDevice", provisionDeviceSchema],
      ] as const) {
        ToolRegistry.register(name, name, schema as any, async () => ({ content: [] }));
      }

      const definitions = ToolRegistry.getToolDefinitions();
      const selectionDefinition = definitions.find(
        (tool) => tool.name === SET_TOOL_ENABLED_TOOL_NAME,
      )!;
      const properties = selectionDefinition.inputSchema.properties as Record<string, any>;
      const advertised = properties.toolName.enum as string[];
      const configurable = new Set(
        ToolRegistry.getAllTools()
          .filter((tool) => ToolRegistry.isUserConfigurableTool(tool.name))
          .map((tool) => tool.name),
      );

      expect(advertised.every((toolName) => configurable.has(toolName))).toBe(true);
      for (const tool of ToolRegistry.getAllTools()) {
        if (tool.defaultEnabled === false && ToolRegistry.isUserConfigurableTool(tool.name)) {
          expect(advertised).toContain(tool.name);
        }
      }
      expect(advertised).not.toContain("getAndroid");
      expect(advertised).not.toContain("getApple");
      expect(advertised).toContain("provisionDevice");
      expect(advertised).not.toContain(SET_TOOL_ENABLED_TOOL_NAME);
    });

    test("an acquisition call naming an unconfigurable tool fails its advertised schema", () => {
      ToolRegistry.register("getAndroid", "getAndroid", getAndroidSchema as any, async () => ({
        content: [{ type: "text" as const, text: "getAndroid" }],
      }));
      const definition = ToolRegistry.getToolDefinitions().find(
        (tool) => tool.name === "getAndroid",
      )!;
      const validate = new Ajv2020({ strict: false }).compile(definition.inputSchema);

      expect(validate({ deviceId: "emulator-5554", enableTools: ["inputText"] })).toBe(true);
      expect(validate({ deviceId: "emulator-5554", enableTools: ["notATool"] })).toBe(false);
    });

    test("advertises the exactly-one-name rule so a client cannot build a rejected call", () => {
      const definition = ToolRegistry.getToolDefinitions().find(
        (tool) => tool.name === SET_TOOL_ENABLED_TOOL_NAME,
      )!;
      const validate = new Ajv2020({ strict: false }).compile(definition.inputSchema);

      expect(validate({ toolName: "inputText" })).toBe(true);
      expect(validate({ toolNames: ["inputText"] })).toBe(true);
      expect(validate({ toolName: "inputText", toolNames: ["clearText"] })).toBe(false);
      expect(validate({ enabled: true })).toBe(false);
    });

    test("keeps the advertised setToolEnabled schema free of top-level combinators", () => {
      const schema = ToolRegistry.getToolDefinitions().find(
        (tool) => tool.name === SET_TOOL_ENABLED_TOOL_NAME,
      )!.inputSchema as Record<string, unknown>;

      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
      expect(schema.allOf).toBeUndefined();
      expect(schema.type).toBe("object");
    });

    test("still advertises sessionUuid as a top-level property", () => {
      const properties = (z.toJSONSchema(setToolEnabledSchema, { io: "input" }) as any).properties;
      expect(Object.keys(properties).sort()).toEqual([
        "enabled",
        "sessionUuid",
        "toolName",
        "toolNames",
      ]);
    });
  });
});
