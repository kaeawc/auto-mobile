import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { registerDatabaseTools, sqlQuerySchema } from "../../src/server/databaseTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { IosDatabaseClient } from "../../src/server/iosDatabaseClient";
import { isolateToolRegistry, withTemporaryTool } from "../helpers/withTemporaryTool";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { SQLResult } from "../../src/features/database/DatabaseInspector";

isolateToolRegistry();

let embeddedSdkEnabled: boolean;
beforeEach(() => {
  embeddedSdkEnabled = serverConfig.isEmbeddedSdkEnabled();
  serverConfig.setEmbeddedSdkEnabled(true);
});
afterEach(() => serverConfig.setEmbeddedSdkEnabled(embeddedSdkEnabled));

const internalArgs = {
  __mcpSessionId: "test-session",
  __oneShotCli: true,
  __executionId: "test-execution",
  __executionStartTime: 1,
  __mcpRequestTimeoutMs: 1000,
  __mcpRequestDeadlineMs: 1001,
  __mcpLiveDeadlineKey: "test-deadline",
};

const device = { deviceId: "ios-test", platform: "ios", name: "Fake iPhone" } as const;

test("registered sqlQuery forwards Core Data and SQL arguments with internal metadata", async () => {
  const result: SQLResult = {
    type: "query",
    columns: ["name"],
    rows: [["Apple"]],
    truncated: true,
  };
  const queryCoreDataForIos = mock(async () => result);
  const executeSQLForIos = mock(async () => result);
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected database resource call");
  };
  const client: IosDatabaseClient = {
    queryCoreDataForIos,
    executeSQLForIos,
    listDatabasesForIos: unused,
    listTablesForIos: unused,
    getTableDataForIos: unused,
    getTableStructureForIos: unused,
  };
  await withTemporaryTool(
    "sqlQuery",
    () => registerDatabaseTools(() => client),
    async () => {
      const handler = ToolRegistry.getTool("sqlQuery")!.deviceAwareHandler!;
      for (const args of [
        { store: "Main", entity: "Item", limit: 2 },
        { databasePath: "app.db", query: "SELECT name FROM Item" },
      ]) {
        expect(
          await handler(device, { appId: "com.example.app", ...args, ...internalArgs }),
        ).toMatchObject({
          structuredContent: result,
        });
      }
      expect(queryCoreDataForIos).toHaveBeenCalledWith("com.example.app", "Main", "Item", 2);
      expect(executeSQLForIos).toHaveBeenCalledWith(
        "com.example.app",
        "app.db",
        "SELECT name FROM Item",
        { readOnly: true },
      );
    },
  );
});

test("registered sqlQuery refuses incomplete or mixed modes before contacting a bridge", async () => {
  const resolveClient = mock((): never => {
    throw new Error("Unexpected database bridge call");
  });
  await withTemporaryTool(
    "sqlQuery",
    () => registerDatabaseTools(resolveClient),
    async () => {
      const handler = ToolRegistry.getTool("sqlQuery")!.deviceAwareHandler!;
      for (const args of [
        {},
        { store: "Main" },
        { databasePath: "app.db" },
        { store: "Main", entity: "Item", query: "SELECT 1" },
        { databasePath: "app.db", query: "SELECT 1", limit: 2 },
        { store: "Main", entity: "Item", limit: 0 },
        { store: "Main", entity: "Item", limit: 1.5 },
      ]) {
        await expect(
          handler(device, { appId: "com.example.app", ...args, ...internalArgs }),
        ).rejects.toThrow("Supply");
      }
      expect(resolveClient).not.toHaveBeenCalled();
    },
  );
});

test("sqlQuery accepts exactly one complete database mode", () => {
  const appId = "com.example.app";
  for (const args of [
    { databasePath: "app.db", query: "SELECT 1" },
    { store: "Main", entity: "Item", limit: 2 },
  ]) {
    expect(sqlQuerySchema.safeParse({ appId, ...args }).success).toBe(true);
  }
  for (const args of [
    {},
    { store: "Main" },
    { entity: "Item" },
    { databasePath: "app.db" },
    { query: "SELECT 1" },
    { store: "Main", entity: "Item", query: "SELECT 1" },
    { databasePath: "app.db", query: "SELECT 1", limit: 2 },
    { store: "Main", entity: "Item", limit: 0 },
    { store: "Main", entity: "Item", limit: 1.5 },
  ]) {
    expect(sqlQuerySchema.safeParse({ appId, ...args }).success).toBe(false);
  }
});
