import { DeviceResourceApplicationRepository } from "../../src/db/deviceResourceApplicationRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceResourceApplicationStore } from "../fakes/FakeDeviceResourceApplicationStore";
import { runDeviceResourceApplicationStoreContract } from "./DeviceResourceApplicationStoreContract";

// The real repository runs over createTestDatabase() (in-memory SQLite), never the
// file-backed database (#11868).
runDeviceResourceApplicationStoreContract("FakeDeviceResourceApplicationStore", async () => ({
  store: new FakeDeviceResourceApplicationStore(),
}));
runDeviceResourceApplicationStoreContract("DeviceResourceApplicationRepository", async () => {
  const db = await createTestDatabase();
  return { store: new DeviceResourceApplicationRepository({ db }), dispose: () => db.destroy() };
});
