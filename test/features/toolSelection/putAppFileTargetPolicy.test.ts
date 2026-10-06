import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionToolSelectionService } from "../../../src/features/toolSelection/SessionToolSelectionService";
import {
  PUT_APP_FILE_TARGET_TOOLS,
  resolvePutAppFileTargetEnablement,
} from "../../../src/features/toolSelection/putAppFileTargetPolicy";
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
  test("every domain names only putAppFile and is enabled by default", async () => {
    expect(PUT_APP_FILE_TARGET_TOOLS).toEqual({
      app_containers: ["putAppFile"],
      user_files: ["putAppFile"],
      media_library: ["putAppFile"],
    });
    expect(await targets(selection().service)).toEqual([true, true, true]);
  });

  test.each([
    [[["stageSharedStorage", false]], [true, true, true]],
    [[["stageSharedStorageFixtures", false]], [true, true, true]],
    [
      [
        ["putAppFile", false],
        ["stageSharedStorage", true],
        ["stageSharedStorageFixtures", true],
      ],
      [false, false, false],
    ],
    [
      [
        ["putAppFile", false],
        ["stageSessionDownloads", true],
      ],
      [false, false, false],
    ],
    [[["putAppFile", true]], [true, true, true]],
  ] as Array<[Array<[string, boolean]>, boolean[]]>)(
    "stored overrides %j resolve targets %j without migration or deletion",
    async (entries, expected) => {
      const { repository, service } = selection(entries);
      const before = new Map(repository.rows.get("session"));
      expect(await targets(service)).toEqual(expected);
      expect(repository.rows.get("session")).toEqual(before);
      expect(repository.writes).toEqual([]);
      expect(repository.singleWrites).toEqual([]);
      expect(repository.batches).toEqual([]);
      const discovered = await listEnabledToolNames(service, ["session"]);
      expect(discovered).not.toContain("stageSharedStorage");
      expect(discovered).not.toContain("stageSharedStorageFixtures");
    },
  );

  test("stored overrides take precedence over startup defaults for all domains", async () => {
    expect(await targets(selection([], [["putAppFile", false]]).service)).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      await targets(selection([["putAppFile", false]], [["putAppFile", true]]).service),
    ).toEqual([false, false, false]);
    expect(
      await targets(selection([["putAppFile", true]], [["putAppFile", false]]).service),
    ).toEqual([true, true, true]);
  });

  test("discovery enables putAppFile and preserves the separate session Downloads registration", async () => {
    expect(ToolRegistry.getRegisteredTool("putAppFile")?.defaultEnabled).toBe(true);
    for (const name of ["stageSharedStorage", "stageSharedStorageFixtures"]) {
      expect(ToolRegistry.getRegisteredTool(name)).toBeUndefined();
      expect(ToolRegistry.getToolDefinitions().some((tool) => tool.name === name)).toBe(false);
    }
    const downloads = ToolRegistry.getRegisteredTool("stageSessionDownloads")!;
    expect(downloads.defaultEnabled).toBe(false);
    expect(downloads.requiresDevice).toBe(true);
    expect(
      downloads.schema.safeParse({
        sessionUuid: "session",
        directory: "fixtures",
        files: [{ destinationPath: "a.txt", contentText: "a" }],
      }).success,
    ).toBe(true);
    expect(await listEnabledToolNames(selection().service, ["session"])).toEqual(["putAppFile"]);
  });

  test("connection and routing profiles retain union and explicit precedence", async () => {
    const { repository, service } = selection([["putAppFile", false]]);
    repository.rows.set("connection", new Map([["putAppFile", true]]));
    const enabled = () =>
      isToolEnabledForAnyRoute("putAppFile", true, [["session"]], service, "connection");
    expect(await enabled()).toBe(true);
    expect(await listEnabledToolNames(service, ["session"], "connection")).toEqual(["putAppFile"]);
    repository.rows.set("connection", new Map([["putAppFile", false]]));
    expect(await enabled()).toBe(false);
    repository.rows.set("session", new Map([["putAppFile", true]]));
    expect(await enabled()).toBe(true);
  });
});
