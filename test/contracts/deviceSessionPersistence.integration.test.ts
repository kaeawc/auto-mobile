import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { runDeviceSessionPersistenceContract } from "./DeviceSessionPersistenceContract";

// The real repository runs over createTestDatabase() (in-memory SQLite), never the
// file-backed database (#11868).
runDeviceSessionPersistenceContract("FakeDeviceSessionRepository", async () => ({
  repository: new FakeDeviceSessionRepository(),
}));
runDeviceSessionPersistenceContract("DeviceSessionRepository (SQLite)", async () => {
  const db = await createTestDatabase();
  return { repository: new DeviceSessionRepository(db), dispose: () => db.destroy() };
});
