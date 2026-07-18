/**
 * JSON (de)serialization for {@link VouchState}.
 *
 * The engine is storage-agnostic. The daemon/MCP path persists the graph in
 * SQLite (`VouchRepository`); the GitHub-Action path instead keeps the graph as a
 * committed JSON file in the repo, so the trust graph is transparent and auditable
 * through git history. This module is the bridge for the latter.
 */

import { emptyVouchState, type InviteToken, type Member, type VouchState } from "./types";

export const VOUCH_SNAPSHOT_VERSION = 1;

export interface VouchSnapshot {
  version: number;
  members: Member[];
  invites: InviteToken[];
}

/** Serialize state to a stable, diff-friendly snapshot (entries sorted by key). */
export function serializeVouchState(state: VouchState): VouchSnapshot {
  const members = [...state.members.values()].sort((a, b) => a.login.localeCompare(b.login));
  const invites = [...state.invites.values()].sort((a, b) => a.token.localeCompare(b.token));
  return { version: VOUCH_SNAPSHOT_VERSION, members, invites };
}

/** Serialize to a pretty-printed JSON string suitable for committing to the repo. */
export function stringifyVouchState(state: VouchState): string {
  return `${JSON.stringify(serializeVouchState(state), null, 2)}\n`;
}

/** Rebuild state from a snapshot object. Unknown/missing fields are tolerated defensively. */
export function deserializeVouchState(snapshot: VouchSnapshot): VouchState {
  const state = emptyVouchState();
  for (const member of snapshot.members ?? []) {
    state.members.set(member.login, member);
  }
  for (const invite of snapshot.invites ?? []) {
    state.invites.set(invite.token, invite);
  }
  return state;
}

/** Parse a JSON string into state. An empty/blank string yields an empty graph. */
export function parseVouchState(json: string): VouchState {
  const trimmed = json.trim();
  if (trimmed.length === 0) {
    return emptyVouchState();
  }
  const snapshot = JSON.parse(trimmed) as VouchSnapshot;
  return deserializeVouchState(snapshot);
}
