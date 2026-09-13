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

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
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

describe("setToolEnabled batch enable (#6869)", () => {
  let repository: FakeRepository;
  let service: SessionToolSelectionService;

  const callSetToolEnabled = async (args: Record<string, unknown>): Promise<any> => {
    const tool = ToolRegistry.getTool(SET_TOOL_ENABLED_TOOL_NAME)!;
    const parsed = tool.schema.parse(args);
    return await runWithToolSelectionContext(
      { routingSessionUuid: SESSION_UUID, sessionToolSelectionService: service },
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

  test("applies a repeated name once", async () => {
    await callSetToolEnabled({ toolNames: ["inputText", "inputText"] });

    expect(repository.writes).toEqual([[SESSION_UUID, "inputText", true]]);
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
