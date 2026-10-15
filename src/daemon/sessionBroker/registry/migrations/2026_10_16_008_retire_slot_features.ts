import { sql, type Kysely } from "kysely";
import { ActionableError } from "../../../../models/ActionableError";
import { SESSION_BROKER_SCOPE } from "../../hostConfig";
import { BROKER_BINDING_ROLE } from "../../persistedIdentity";
import { computeBindingScopeKey } from "../bindingRegistry";

/** A journal belongs to the surviving broker binding only when its exact key does. */
export const legacyJournalPredicate = sql`NOT EXISTS (
  SELECT 1 FROM slot_assignments a WHERE a.scope_key = slot_journal.scope_key
  AND a.slot_index = slot_journal.slot_index AND a.role = ${BROKER_BINDING_ROLE})`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // Check everything before the first write: direct migration must never orphan a native device.
  const unsafe = await sql<{ unsafe: number }>`SELECT
    EXISTS(SELECT 1 FROM slot_assignments WHERE role <> ${BROKER_BINDING_ROLE}
      AND stable_device_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM slot_journal WHERE ${legacyJournalPredicate}
      AND phase NOT IN ('committed', 'rolled_back'))
    OR EXISTS(SELECT 1 FROM slot_free_devices) AS unsafe`.execute(db);
  if (unsafe.rows[0].unsafe) {
    throw new ActionableError(
      "Legacy slot devices must be retired first. Restart the daemon to confirm their shutdown before upgrading the binding registry.",
    );
  }
  await deleteLegacyBindingRows(db);
  await db.schema.dropTable("slot_free_devices").execute();
}

/** Shared with pre-migration retirement, including registries predating the journal/broker tables. */
export async function deleteLegacyBindingRows<DB>(
  db: Kysely<DB>,
  schema = { hasJournal: true, hasBrokerResources: true },
): Promise<void> {
  if (schema.hasJournal) {
    await sql`DELETE FROM slot_journal WHERE ${legacyJournalPredicate}`.execute(db);
  }
  await sql`DELETE FROM slot_assignments WHERE role <> ${BROKER_BINDING_ROLE}`.execute(db);
  const journalReferences = schema.hasJournal
    ? sql`AND NOT EXISTS (SELECT 1 FROM slot_journal j WHERE j.scope_key = slot_scopes.scope_key)`
    : sql``;
  const brokerReferences = schema.hasBrokerResources
    ? sql`AND NOT EXISTS (SELECT 1 FROM session_broker_resources r WHERE r.scope_key = slot_scopes.scope_key)`
    : sql``;
  await sql`DELETE FROM slot_scopes WHERE scope_key <> ${computeBindingScopeKey(SESSION_BROKER_SCOPE)}
    AND NOT EXISTS (SELECT 1 FROM slot_assignments a WHERE a.scope_key = slot_scopes.scope_key)
    ${journalReferences} ${brokerReferences}`.execute(db);
}

export async function down(): Promise<void> {
  // Retirement is irreversible: stopped images remain on disk, but retired ownership cannot be recreated.
  throw new ActionableError(
    "Legacy slot retirement is irreversible; restore a pre-upgrade backup instead.",
  );
}
