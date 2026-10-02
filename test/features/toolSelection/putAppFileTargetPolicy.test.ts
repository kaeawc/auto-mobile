import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionToolSelectionService } from "../../../src/features/toolSelection/SessionToolSelectionService";
import { resolvePutAppFileTargetEnablement } from "../../../src/features/toolSelection/putAppFileTargetPolicy";
import { isToolEnabledForAnyRoute } from "../../../src/features/toolSelection/toolSelectionPolicy";
import { registerAppFileTools } from "../../../src/server/appFileTools";
import { registerSharedStorageTools } from "../../../src/server/sharedStorageTools";
import { registerDownloadsFixtureTools } from "../../../src/server/downloadsFixtureTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { listEnabledToolNames } from "../../../src/server/toolSelectionTools";
import { FakeToolSelectionRepository } from "../../fakes/FakeToolSelectionRepository";

beforeEach(() => {
  ToolRegistry.clearTools();
  registerAppFileTools();
  registerSharedStorageTools();
  registerDownloadsFixtureTools();
});
afterEach(() => ToolRegistry.clearTools());
function selection(entries: Array<[string, boolean]> = [], startup: Array<[string, boolean]> = []) {
  const repository = new FakeToolSelectionRepository();
  repository.rows.set("session", new Map(entries));
  return { repository, service: new SessionToolSelectionService(repository, new Map(startup)) };
}
async function targets(service: SessionToolSelectionService) {
  return Promise.all(
    (["app_containers", "user_files", "media_library"] as const).map((domain) =>
      resolvePutAppFileTargetEnablement(service, "session", domain, ToolRegistry),
    ),
  );
}

describe("putAppFile target session policy", () => {
  test.each([
    [[], [false, true, false]],
    [[["stageSharedStorage", true]], [false, true, false]],
    [[["stageSharedStorage", false]], [false, false, false]],
    [
      [
        ["stageSharedStorage", false],
        ["stageSharedStorageFixtures", true],
      ],
      [false, true, false],
    ],
    [[["stageSharedStorageFixtures", false]], [false, true, false]],
    [
      [
        ["putAppFile", true],
        ["stageSharedStorage", false],
      ],
      [true, true, true],
    ],
    [[["putAppFile", false]], [false, true, false]],
    [
      [
        ["putAppFile", false],
        ["stageSharedStorage", false],
        ["stageSharedStorageFixtures", true],
      ],
      [false, true, false],
    ],
    [
      [
        ["stageSessionDownloads", true],
        ["stageSharedStorage", false],
      ],
      [false, false, false],
    ],
  ] as Array<[Array<[string, boolean]>, boolean[]]>)(
    "stored overrides %j resolve targets %j without mutations",
    async (entries, expected) => {
      const { repository, service } = selection(entries);
      const before = new Map(repository.rows.get("session"));
      expect(await targets(service)).toEqual(expected);
      expect(repository.rows.get("session")).toEqual(before);
      expect(repository.writes).toEqual([]);
      expect(repository.singleWrites).toEqual([]);
      expect(repository.batches).toEqual([]);
    },
  );

  test.each([
    [[["stageSharedStorage", false]], [false, false, false]],
    [
      [
        ["stageSharedStorage", false],
        ["stageSharedStorageFixtures", true],
      ],
      [false, true, false],
    ],
    [[["putAppFile", true]], [true, true, true]],
  ] as Array<[Array<[string, boolean]>, boolean[]]>)(
    "startup defaults %j use the same target mapping",
    async (startup, expected) => {
      const { service } = selection([], startup);
      expect(await targets(service)).toEqual(expected);
    },
  );

  test("stored disable beats startup enable and stored enable beats startup disable", async () => {
    const disabled = selection([["stageSharedStorage", false]], [["stageSharedStorage", true]]);
    expect(await targets(disabled.service)).toEqual([false, false, false]);
    const enabled = selection([["stageSharedStorage", true]], [["stageSharedStorage", false]]);
    expect(await targets(enabled.service)).toEqual([false, true, false]);
  });

  test("discovery remains exact-name based, with real unchanged registration defaults", async () => {
    const { service } = selection();
    expect(ToolRegistry.getRegisteredTool("putAppFile")?.defaultEnabled).toBe(false);
    expect(ToolRegistry.getRegisteredTool("stageSharedStorage")?.defaultEnabled).toBe(true);
    expect(ToolRegistry.getRegisteredTool("stageSharedStorageFixtures")?.defaultEnabled).toBe(
      false,
    );
    expect(ToolRegistry.getRegisteredTool("stageSessionDownloads")?.defaultEnabled).toBe(false);
    expect(await listEnabledToolNames(service, ["session"])).toEqual(["stageSharedStorage"]);
    await service.setEnabled("session", "stageSharedStorage", true);
    expect(await listEnabledToolNames(service, ["session"])).toEqual(["stageSharedStorage"]);
    expect(await resolvePutAppFileTargetEnablement(service, "session", "app_containers")).toBe(
      false,
    );
  });

  test("real legacy descriptions and registrations remain available through the transition", () => {
    for (const name of [
      "stageSharedStorage",
      "stageSharedStorageFixtures",
      "stageSessionDownloads",
    ]) {
      expect(ToolRegistry.getRegisteredTool(name)?.description).toStartWith(
        'Deprecated alias of putAppFile with target.domain "user_files"',
      );
    }
  });

  test("connection and routing profiles retain the documented union and explicit precedence", async () => {
    const { repository, service } = selection([["stageSharedStorage", false]]);
    repository.rows.set("connection", new Map([["stageSharedStorage", true]]));
    const enabled = (name: string) =>
      isToolEnabledForAnyRoute(
        name,
        ToolRegistry.getRegisteredTool(name)!.defaultEnabled,
        [["session"]],
        service,
        "connection",
      );
    expect(await enabled("stageSharedStorage")).toBe(true);
    expect(await enabled("putAppFile")).toBe(false);
    expect(await listEnabledToolNames(service, ["session"], "connection")).toEqual([
      "stageSharedStorage",
    ]);
    repository.rows.set("connection", new Map([["stageSharedStorage", false]]));
    expect(await enabled("stageSharedStorage")).toBe(false);
    repository.rows.set("session", new Map([["stageSharedStorage", true]]));
    expect(await enabled("stageSharedStorage")).toBe(true);
    repository.rows.set("connection", new Map([["putAppFile", true]]));
    expect(await enabled("putAppFile")).toBe(true);
    expect(await resolvePutAppFileTargetEnablement(service, "session", "app_containers")).toBe(
      false,
    );
  });
});
