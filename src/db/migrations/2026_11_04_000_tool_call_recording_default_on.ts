import { type Kysely, sql } from "kysely";

// #16891: tool-call-recording now defaults on. ensureFlags() persisted the old
// default (off) on every existing install, and a stored off cannot be told apart
// from that default, so turn the stored row on. recordToolCalls stays opt-in via
// setToolEnabled, so this only lets an enabled tool's begin/end run.
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`UPDATE feature_flags SET enabled = 1
    WHERE key = 'tool-call-recording' AND enabled = 0`.execute(db);
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await sql`UPDATE feature_flags SET enabled = 0
    WHERE key = 'tool-call-recording' AND enabled = 1`.execute(db);
}
