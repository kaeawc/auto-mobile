import { sql, type Kysely } from "kysely";

// #11337: a free-pool device unadopted for an hour is shut down but its row (the image) is kept.
// `state` records how far that shutdown got: `free` (booted or unknown), `stopping` (a sweep
// claimed it and is shutting it down; adoption waits) and `stopped` (verified shut down, still
// adoptable by a matching binding, which boots it).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_free_devices
    ADD COLUMN state TEXT NOT NULL DEFAULT 'free'
    CHECK (state IN ('free', 'stopping', 'stopped'))`.execute(db);
  // Who claimed a `stopping` row and when, so only the claimer (or another daemon once the claim
  // is stale) drives the shutdown.
  await sql`ALTER TABLE slot_free_devices ADD COLUMN stop_claimed_by TEXT`.execute(db);
  await sql`ALTER TABLE slot_free_devices ADD COLUMN stop_claimed_at_ms INTEGER`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_free_devices DROP COLUMN stop_claimed_at_ms`.execute(db);
  await sql`ALTER TABLE slot_free_devices DROP COLUMN stop_claimed_by`.execute(db);
  await sql`ALTER TABLE slot_free_devices DROP COLUMN state`.execute(db);
}
