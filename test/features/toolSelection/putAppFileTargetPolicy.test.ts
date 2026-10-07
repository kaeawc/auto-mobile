import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionToolSelectionService } from "../../../src/features/toolSelection/SessionToolSelectionService";
import { resolvePutAppFileTargetEnablement } from "../../../src/features/toolSelection/putAppFileTargetPolicy";
import { isToolEnabledForAnyRoute } from "../../../src/features/toolSelection/toolSelectionPolicy";
import { registerAppFileTools } from "../../../src/server/appFileTools";
import { registerDownloadsFixtureTools } from "../../../src/server/downloadsFixtureTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { listEnabledToolNames } from "../../../src/server/toolSelectionTools";
import { FakeToolSelectionRepository } from "../../fakes/FakeToolSelectionRepository";

beforeEach(() => {
  ToolRegistry.clearTools();
  registerAppFileTools();
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
    [[], [true, true, true]],
    [[["putAppFile", false]], [false, false, false]],
    [[["putAppFile", true]], [true, true, true]],
    [[["stageSharedStorage", false]], [true, true, true]],
    [
      [
        ["putAppFile", false],
        ["stageSharedStorage", true],
        ["stageSharedStorageFixtures", true],
        ["stageSessionDownloads", true],
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
    [[["putAppFile", false]], [false, false, false]],
    [[["putAppFile", true]], [true, true, true]],
    [[["stageSharedStorage", false]], [true, true, true]],
  ] as Array<[Array<[string, boolean]>, boolean[]]>)(
    "startup defaults %j use the same target mapping",
    async (startup, expected) => {
      expect(await targets(selection([], startup).service)).toEqual(expected);
    },
  );

  test("stored disable beats startup enable and stored enable beats startup disable", async () => {
    expect(
      await targets(selection([["putAppFile", false]], [["putAppFile", true]]).service),
    ).toEqual([false, false, false]);
    expect(
      await targets(selection([["putAppFile", true]], [["putAppFile", false]]).service),
    ).toEqual([true, true, true]);
  });

  test("discovery enables putAppFile by default and excludes removed registrations", async () => {
    const { service } = selection();
    expect(ToolRegistry.getRegisteredTool("putAppFile")?.defaultEnabled).toBe(true);
    expect(ToolRegistry.getRegisteredTool("stageSharedStorage")).toBeUndefined();
    expect(ToolRegistry.getRegisteredTool("stageSharedStorageFixtures")).toBeUndefined();
    expect(ToolRegistry.getRegisteredTool("stageSessionDownloads")?.defaultEnabled).toBe(false);
    expect(await listEnabledToolNames(service, ["session"])).toEqual(["putAppFile"]);
    await service.setEnabled("session", "putAppFile", false);
    expect(await listEnabledToolNames(service, ["session"])).toEqual([]);
  });

  test("removed-name stored grants cannot restore discovery", async () => {
    const { service } = selection([
      ["putAppFile", false],
      ["stageSharedStorage", true],
    ]);
    expect(await listEnabledToolNames(service, ["session"])).toEqual([]);
  });

  test("connection and routing profiles retain union and explicit precedence", async () => {
    const { repository, service } = selection([["putAppFile", false]]);
    repository.rows.set("connection", new Map([["putAppFile", true]]));
    const enabled = () =>
      isToolEnabledForAnyRoute("putAppFile", true, [["session"]], service, "connection");
    expect(await enabled()).toBe(true);
    expect(await listEnabledToolNames(service, ["session"], "connection")).toEqual(["putAppFile"]);
    expect(await targets(service)).toEqual([false, false, false]);
    repository.rows.set("connection", new Map([["putAppFile", false]]));
    expect(await enabled()).toBe(false);
    repository.rows.set("session", new Map([["putAppFile", true]]));
    expect(await enabled()).toBe(true);
  });
});
