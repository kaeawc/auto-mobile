import { describe, expect, test } from "bun:test";
import {
  getEnvironmentToolDefaults,
  getStartupToolDefaults,
  SessionToolSelectionService,
  type SessionToolSelectionRepository,
} from "../../../src/features/toolSelection/SessionToolSelectionService";

class FakeRepository implements SessionToolSelectionRepository {
  readonly rows = new Map<string, Map<string, boolean>>();
  readonly singleWrites: Array<[string, string, boolean]> = [];
  readonly batches: Array<[string, ReadonlyArray<{ toolName: string; enabled: boolean }>]> = [];

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
    return new Map(this.rows.get(sessionUuid) ?? []);
  }

  async set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void> {
    this.singleWrites.push([sessionUuid, toolName, enabled]);
    const values = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    values.set(toolName, enabled);
    this.rows.set(sessionUuid, values);
  }

  async setMany(
    sessionUuid: string,
    entries: ReadonlyArray<{ toolName: string; enabled: boolean }>,
  ): Promise<void> {
    this.batches.push([sessionUuid, entries]);
    const values = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    for (const entry of entries) {
      values.set(entry.toolName, entry.enabled);
    }
    this.rows.set(sessionUuid, values);
  }

  async deleteSession(sessionUuid: string): Promise<void> {
    this.rows.delete(sessionUuid);
  }
}

/** A repository with no batch support, to exercise the per-name fallback. */
class SingleWriteOnlyRepository implements SessionToolSelectionRepository {
  readonly writes: Array<[string, string, boolean]> = [];
  private readonly rows = new Map<string, Map<string, boolean>>();

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
    return new Map(this.rows.get(sessionUuid) ?? []);
  }

  async set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void> {
    this.writes.push([sessionUuid, toolName, enabled]);
    const values = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    values.set(toolName, enabled);
    this.rows.set(sessionUuid, values);
  }

  async deleteSession(sessionUuid: string): Promise<void> {
    this.rows.delete(sessionUuid);
  }
}

describe("SessionToolSelectionService", () => {
  test("uses each tool's declared default before a session override exists", async () => {
    const service = new SessionToolSelectionService(new FakeRepository());

    expect(await service.isEnabled(undefined, "observe", true)).toBe(true);
    expect(await service.isEnabled(undefined, "clipboard", false)).toBe(false);
  });

  test("applies startup overrides over declared defaults", async () => {
    const service = new SessionToolSelectionService(
      new FakeRepository(),
      new Map([
        ["observe", false],
        ["clipboard", true],
      ]),
    );

    expect(await service.isEnabled("session-1", "observe", true)).toBe(false);
    expect(await service.isEnabled("session-1", "clipboard", false)).toBe(true);
  });

  test("persists an exact-tool session override across service instances", async () => {
    const repository = new FakeRepository();
    const first = new SessionToolSelectionService(repository, new Map([["clipboard", true]]));
    await first.setEnabled("session-1", "clipboard", false);

    const restarted = new SessionToolSelectionService(repository, new Map([["clipboard", true]]));
    expect(await restarted.isEnabled("session-1", "clipboard", false)).toBe(false);
  });

  test("does not let one tool override affect a sibling from the former group", async () => {
    const repository = new FakeRepository();
    const service = new SessionToolSelectionService(repository);
    await service.setEnabled("session-1", "clipboard", true);

    expect(await service.isEnabled("session-1", "clipboard", false)).toBe(true);
    expect(await service.isEnabled("session-1", "selectAllText", false)).toBe(false);
  });
  // #6886 review — a batch must reach the repository as ONE operation, so the
  // repository (SQLite: a transaction) owns its atomicity. A per-name loop here
  // would leave the first names written when a later one fails.
  test("hands a whole batch to the repository as a single operation", async () => {
    const repository = new FakeRepository();
    const service = new SessionToolSelectionService(repository);

    await service.setEnabledMany("session-1", ["inputText", "clearText"], true);

    expect(repository.batches).toEqual([
      [
        "session-1",
        [
          { toolName: "inputText", enabled: true },
          { toolName: "clearText", enabled: true },
        ],
      ],
    ]);
    expect(repository.singleWrites).toEqual([]);
    expect(await repository.list("session-1")).toEqual(
      new Map([
        ["inputText", true],
        ["clearText", true],
      ]),
    );
  });

  test("falls back to per-name writes for a repository without batch support", async () => {
    const repository = new SingleWriteOnlyRepository();
    const service = new SessionToolSelectionService(repository);

    await service.setEnabledMany("session-1", ["inputText", "clearText"], false);

    expect(repository.writes).toEqual([
      ["session-1", "inputText", false],
      ["session-1", "clearText", false],
    ]);
  });
});

describe("getEnvironmentToolDefaults", () => {
  const knownTools = new Set(["observe", "clipboard", "sqlQuery"]);

  test("parses exact enabled and disabled tool-name lists", () => {
    expect(
      getEnvironmentToolDefaults(
        {
          AUTOMOBILE_ENABLED_TOOLS: "clipboard,sqlQuery",
          AUTOMOBILE_DISABLED_TOOLS: "observe",
        },
        knownTools,
      ),
    ).toEqual(
      new Map([
        ["clipboard", true],
        ["sqlQuery", true],
        ["observe", false],
      ]),
    );
  });

  test("rejects unknown names, wrong casing, and same-layer conflicts", () => {
    expect(() =>
      getEnvironmentToolDefaults({ AUTOMOBILE_ENABLED_TOOLS: "Clipboard" }, knownTools),
    ).toThrow("Unknown tool name 'Clipboard'");
    expect(() =>
      getEnvironmentToolDefaults(
        {
          AUTOMOBILE_ENABLED_TOOLS: "clipboard",
          AUTOMOBILE_DISABLED_TOOLS: "clipboard",
        },
        knownTools,
      ),
    ).toThrow("both enabled and disabled");
  });

  test("fails fast when a retired group variable is present", () => {
    expect(() =>
      getEnvironmentToolDefaults({ AUTOMOBILE_TOOLSET_CLIPBOARD: "1" }, knownTools),
    ).toThrow("AUTOMOBILE_TOOLSET_CLIPBOARD is retired");
  });

  test("lets explicit CLI defaults override environment defaults", () => {
    expect(
      getStartupToolDefaults(
        {
          AUTOMOBILE_ENABLED_TOOLS: "observe",
          AUTOMOBILE_DISABLED_TOOLS: "clipboard",
        },
        knownTools,
        ["clipboard"],
        ["observe"],
      ),
    ).toEqual(
      new Map([
        ["observe", false],
        ["clipboard", true],
      ]),
    );
  });
});
