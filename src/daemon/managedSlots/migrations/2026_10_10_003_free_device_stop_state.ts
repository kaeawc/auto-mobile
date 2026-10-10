import { sql, type Kysely } from "kysely";

// #11337: a free-pool device unadopted for an hour is shut down but its row (the image) is kept.
// `state` records how far that shutdown got: `free` (booted or unknown), `stopping` (a sweep
// claimed it and is shutting it down; adoption waits) and `stopped` (verified shut down, still
// adoptable by a matching slot, which boots it).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_free_devices
    ADD COLUMN state TEXT NOT NULL DEFAULT 'free'
    CHECK (state IN ('free', 'stopping', 'stopped'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_free_devices DROP COLUMN state`.execute(db);
}
