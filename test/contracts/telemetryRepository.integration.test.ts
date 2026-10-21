import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { getNetworkEvents, recordNetworkEvent } from "../../src/db/networkEventRepository";
import { getLogEvents, recordLogEvent } from "../../src/db/logEventRepository";
import { getOsEvents, recordOsEvent } from "../../src/db/osEventRepository";
import { getNavigationEvents, recordNavigationEvent } from "../../src/db/navigationEventRepository";
import { getStorageEvents, recordStorageEvent } from "../../src/db/storageEventRepository";
import { getLayoutEvents, recordLayoutEvent } from "../../src/db/layoutEventRepository";
import type { TelemetryRepository } from "../../src/features/telemetry/TelemetryRecorder";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTelemetryRepository } from "../fakes/FakeTelemetryRepository";
import { runTelemetryRepositoryContract } from "./TelemetryRepositoryContract";

const oldestFirst = <T extends { timestamp: number }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.timestamp - b.timestamp);

// The real repositories run over createTestDatabase() (in-memory SQLite), never the
// file-backed database (#11868).
runTelemetryRepositoryContract("FakeTelemetryRepository", async () => {
  const fake = new FakeTelemetryRepository();
  return {
    repository: fake,
    read: {
      network: async () => oldestFirst(fake.networkEvents),
      log: async () => oldestFirst(fake.logEvents),
      os: async () => oldestFirst(fake.osEvents),
      navigation: async () => oldestFirst(fake.navigationEvents),
      storage: async () => oldestFirst(fake.storageEvents),
      layout: async () => oldestFirst(fake.layoutEvents),
    },
  };
});

runTelemetryRepositoryContract("SQLite telemetry repositories", async () => {
  const db: Kysely<Database> = await createTestDatabase();
  const repository: TelemetryRepository = {
    recordNetworkEvent: (input) => recordNetworkEvent(input, db),
    recordLogEvent: (input) => recordLogEvent(input, db),
    recordOsEvent: (input) => recordOsEvent(input, db),
    recordNavigationEvent: (input) => recordNavigationEvent(input, db),
    recordStorageEvent: (input) => recordStorageEvent(input, db),
    recordLayoutEvent: (input) => recordLayoutEvent(input, db),
  };
  return {
    repository,
    read: {
      network: async () =>
        oldestFirst(await getNetworkEvents({}, db)).map(({ id: _id, ...event }) => event),
      log: async () => oldestFirst(await getLogEvents({}, db)),
      os: async () => oldestFirst(await getOsEvents({}, db)),
      navigation: async () => oldestFirst(await getNavigationEvents({}, db)),
      storage: async () => oldestFirst(await getStorageEvents({}, db)),
      layout: async () => oldestFirst(await getLayoutEvents({}, db)),
    },
    dispose: () => db.destroy(),
  };
});
