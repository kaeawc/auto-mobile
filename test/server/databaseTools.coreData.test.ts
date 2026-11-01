import { expect, test } from "bun:test";
import { sqlQuerySchema } from "../../src/server/databaseTools";

test("sqlQuery accepts exactly one complete database mode", () => {
  const appId = "com.example.app";
  for (const args of [
    { databasePath: "app.db", query: "SELECT 1" },
    { store: "Main", entity: "Item", limit: 2 },
  ])
    expect(sqlQuerySchema.safeParse({ appId, ...args }).success).toBe(true);
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
  ])
    expect(sqlQuerySchema.safeParse({ appId, ...args }).success).toBe(false);
});
