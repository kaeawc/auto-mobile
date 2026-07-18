import type { Kysely } from "kysely";
import { ensureMigrations, getDatabase } from "./database";
import type { Database, VouchInvitesTable, VouchMembersTable } from "./types";
import { logger } from "../utils/logger";
import {
  emptyVouchState,
  type InviteToken,
  type Member,
  type VouchState,
} from "../features/vouch/types";
import type { Selectable } from "kysely";

/**
 * Persistence for the vouch trust graph. The graph is small (a repo's contributor
 * set), so the repository loads the whole {@link VouchState} at once and persists
 * members/invites via idempotent upserts — no row is ever deleted (revocation and
 * expiry are status transitions), so a full save is a safe, order-independent
 * upsert.
 */
export class VouchRepository {
  private readonly injectedDb: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.injectedDb = db ?? null;
  }

  private async getDb(): Promise<Kysely<Database>> {
    if (this.injectedDb) {
      return this.injectedDb;
    }
    await ensureMigrations();
    return getDatabase();
  }

  /** Load the entire trust graph into an in-memory state. */
  async loadState(): Promise<VouchState> {
    const db = await this.getDb();
    const state = emptyVouchState();

    const memberRows = await db.selectFrom("vouch_members").selectAll().execute();
    for (const row of memberRows) {
      const member = rowToMember(row);
      state.members.set(member.login, member);
    }

    const inviteRows = await db.selectFrom("vouch_invites").selectAll().execute();
    for (const row of inviteRows) {
      const invite = rowToInvite(row);
      state.invites.set(invite.token, invite);
    }

    return state;
  }

  /** Upsert a single member. */
  async saveMember(member: Member): Promise<void> {
    const db = await this.getDb();
    const row = memberToRow(member);
    await db
      .insertInto("vouch_members")
      .values(row)
      .onConflict(oc =>
        oc.column("login").doUpdateSet({
          role: row.role,
          status: row.status,
          reputation: row.reputation,
          vouched_by: row.vouched_by,
          redeemed_token: row.redeemed_token,
          revocation_cause: row.revocation_cause,
          revocation_reason: row.revocation_reason,
          updated_at_ms: row.updated_at_ms,
        })
      )
      .execute();
  }

  /** Upsert a single invite token. */
  async saveInvite(invite: InviteToken): Promise<void> {
    const db = await this.getDb();
    const row = inviteToRow(invite);
    await db
      .insertInto("vouch_invites")
      .values(row)
      .onConflict(oc =>
        oc.column("token").doUpdateSet({
          status: row.status,
          redeemed_by: row.redeemed_by,
          redeemed_at_ms: row.redeemed_at_ms,
          invalidated_reason: row.invalidated_reason,
        })
      )
      .execute();
  }

  /**
   * Persist an entire state: upsert every member and invite. Foreign-key ordering
   * is handled by inserting members before invites and, within members, seeds
   * (no `vouched_by`) before their descendants.
   */
  async saveState(state: VouchState): Promise<void> {
    const members = orderMembersForInsert([...state.members.values()]);
    for (const member of members) {
      await this.saveMember(member);
    }
    for (const invite of state.invites.values()) {
      await this.saveInvite(invite);
    }
  }

  /**
   * Best-effort load that returns an empty graph (and logs) if the table read
   * fails, for read-only gate checks that must never throw at the call site.
   */
  async loadStateOrEmpty(): Promise<VouchState> {
    try {
      return await this.loadState();
    } catch (error) {
      logger.warn(`[VouchRepository] Failed to load vouch state: ${error}`, error);
      return emptyVouchState();
    }
  }
}

/**
 * Topologically order members so a voucher is always inserted before anyone it
 * vouched in (satisfies the self-referential FK on `vouched_by`). Any member
 * whose voucher is missing from the set is emitted last rather than dropped.
 */
export function orderMembersForInsert(members: Member[]): Member[] {
  const byLogin = new Map(members.map(m => [m.login, m]));
  const ordered: Member[] = [];
  const placed = new Set<string>();

  const place = (member: Member, stack: Set<string>): void => {
    if (placed.has(member.login) || stack.has(member.login)) {
      return;
    }
    stack.add(member.login);
    if (member.vouchedBy && byLogin.has(member.vouchedBy)) {
      place(byLogin.get(member.vouchedBy)!, stack);
    }
    stack.delete(member.login);
    placed.add(member.login);
    ordered.push(member);
  };

  for (const member of members) {
    place(member, new Set());
  }
  return ordered;
}

function rowToMember(row: Selectable<VouchMembersTable>): Member {
  return {
    login: row.login,
    role: row.role,
    status: row.status,
    reputation: row.reputation,
    vouchedBy: row.vouched_by,
    redeemedToken: row.redeemed_token,
    revocationCause: row.revocation_cause,
    revocationReason: row.revocation_reason,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function memberToRow(member: Member): Omit<VouchMembersTable, "created_at"> {
  return {
    login: member.login,
    role: member.role,
    status: member.status,
    reputation: member.reputation,
    vouched_by: member.vouchedBy,
    redeemed_token: member.redeemedToken,
    revocation_cause: member.revocationCause,
    revocation_reason: member.revocationReason,
    created_at_ms: member.createdAtMs,
    updated_at_ms: member.updatedAtMs,
  };
}

function rowToInvite(row: Selectable<VouchInvitesTable>): InviteToken {
  return {
    token: row.token,
    issuedBy: row.issued_by,
    status: row.status,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    redeemedBy: row.redeemed_by,
    redeemedAtMs: row.redeemed_at_ms,
    invalidatedReason: row.invalidated_reason,
  };
}

function inviteToRow(invite: InviteToken): Omit<VouchInvitesTable, "created_at"> {
  return {
    token: invite.token,
    issued_by: invite.issuedBy,
    status: invite.status,
    created_at_ms: invite.createdAtMs,
    expires_at_ms: invite.expiresAtMs,
    redeemed_by: invite.redeemedBy,
    redeemed_at_ms: invite.redeemedAtMs,
    invalidated_reason: invite.invalidatedReason,
  };
}
