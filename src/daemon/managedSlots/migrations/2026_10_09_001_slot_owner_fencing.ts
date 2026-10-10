import { sql, type Kysely } from "kysely";

// #11242: harden the managed-slot registry before the acquire RPC wires it.
// - exec_owner_process_token: the owner's process-generation token, so a reused PID is not live.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_assignments ADD COLUMN exec_owner_process_token TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_assignments DROP COLUMN exec_owner_process_token`.execute(db);
}
