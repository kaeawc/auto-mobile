import { McpTaskRepository } from "../../src/db/mcpTaskRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeMcpTaskStore } from "../fakes/FakeMcpTaskStore";
import { runMcpTaskStoreContract } from "./McpTaskStoreContract";

// The real repository runs over createTestDatabase() (in-memory SQLite), never the
// file-backed database (#11868).
runMcpTaskStoreContract("FakeMcpTaskStore", async (timer) => ({
  store: new FakeMcpTaskStore(timer),
}));
runMcpTaskStoreContract("McpTaskRepository (SQLite)", async (timer) => {
  const db = await createTestDatabase();
  return { store: new McpTaskRepository({ db, timer }), dispose: () => db.destroy() };
});
