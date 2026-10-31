import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { runDeviceSessionLivenessContract } from "./DeviceSessionLivenessContract";

runDeviceSessionLivenessContract("FakeDeviceSessionPersistence", async () => ({
  repository: new FakeDeviceSessionPersistence(),
}));
// The real repository runs over createTestDatabase() (in-memory SQLite), never the file DB.
runDeviceSessionLivenessContract("DeviceSessionRepository (SQLite)", async () => {
  const db = await createTestDatabase();
  return { repository: new DeviceSessionRepository({ db }), dispose: () => db.destroy() };
});
