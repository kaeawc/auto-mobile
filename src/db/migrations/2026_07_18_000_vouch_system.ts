import { type Kysely, sql } from "kysely";

/**
 * Vouch system: a web-of-trust used to gate access for non-contributors opening
 * GitHub issues and pull requests. `vouch_members` is the trust forest (each row
 * points at the member who vouched it in via `vouched_by`); `vouch_invites` holds
 * the single-use tokens members spend to admit newcomers.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("vouch_members")
    .ifNotExists()
    .addColumn("login", "text", col => col.primaryKey())
    .addColumn("role", "text", col => col.notNull())
    .addColumn("status", "text", col => col.notNull().defaultTo("active"))
    .addColumn("reputation", "real", col => col.notNull().defaultTo(0))
    // Self-referential FK to the voucher. ON DELETE SET NULL keeps a dangling
    // child valid if a voucher row is ever hard-deleted (revocation is a status
    // change, so this is just belt-and-braces).
    .addColumn("vouched_by", "text", col =>
      col.references("vouch_members.login").onDelete("set null")
    )
    .addColumn("redeemed_token", "text")
    .addColumn("revocation_cause", "text")
    .addColumn("revocation_reason", "text")
    .addColumn("created_at_ms", "integer", col => col.notNull())
    .addColumn("updated_at_ms", "integer", col => col.notNull())
    .addColumn("created_at", "text", col => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_vouch_members_vouched_by")
    .ifNotExists()
    .on("vouch_members")
    .column("vouched_by")
    .execute();

  await db.schema
    .createIndex("idx_vouch_members_status")
    .ifNotExists()
    .on("vouch_members")
    .column("status")
    .execute();

  await db.schema
    .createTable("vouch_invites")
    .ifNotExists()
    .addColumn("token", "text", col => col.primaryKey())
    .addColumn("issued_by", "text", col => col.notNull().references("vouch_members.login"))
    .addColumn("status", "text", col => col.notNull().defaultTo("pending"))
    .addColumn("created_at_ms", "integer", col => col.notNull())
    .addColumn("expires_at_ms", "integer", col => col.notNull())
    .addColumn("redeemed_by", "text")
    .addColumn("redeemed_at_ms", "integer")
    .addColumn("invalidated_reason", "text")
    .addColumn("created_at", "text", col => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_vouch_invites_issued_by")
    .ifNotExists()
    .on("vouch_invites")
    .column("issued_by")
    .execute();

  await db.schema
    .createIndex("idx_vouch_invites_status")
    .ifNotExists()
    .on("vouch_invites")
    .column("status")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("vouch_invites").ifExists().execute();
  await db.schema.dropTable("vouch_members").ifExists().execute();
}
