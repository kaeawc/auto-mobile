import type { Kysely } from "kysely";
import * as migration from "../../src/daemon/sessionBroker/registry/migrations/2026_10_21_012_device_mutation_journal";
import {
  SqliteDeviceMutationJournal,
  type DeviceMutationTables,
} from "../../src/daemon/sessionBroker/mutations/sqliteJournal";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";
import { runDeviceMutationJournalContract } from "./DeviceMutationJournalContract";

runDeviceMutationJournalContract("FakeDeviceMutationJournal", async () => {
  const timer = new FakeTimer();
  return { journal: new FakeDeviceMutationJournal(timer), timer };
});

// Real side: the SQLite journal over createTestDatabase() (in-memory) with the journal
// migration applied, never the file-backed database (#11868).
runDeviceMutationJournalContract("SqliteDeviceMutationJournal (in-memory)", async () => {
  const db = (await createTestDatabase()).withTables<{
    [Table in keyof DeviceMutationTables]: DeviceMutationTables[Table];
  }>();
  await migration.up(db as Kysely<unknown>);
  const timer = new FakeTimer();
  return {
    journal: new SqliteDeviceMutationJournal(db, timer),
    timer,
    dispose: () => db.destroy(),
  };
});
