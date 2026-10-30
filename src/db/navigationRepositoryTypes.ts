import type { Kysely } from "kysely";
import type { Timer } from "../utils/SystemTimer";
import type { Database } from "./types";
import type { NavigationRepository } from "./navigationRepository";

/**
 * What the query modules extracted from {@link NavigationRepository} need from it: the repository's
 * (possibly executor-bound) connection, its timer, and the repository itself for the few queries
 * that compose its public methods.
 */
export interface NavigationQueryContext {
  readonly timer: Timer;
  readonly repository: NavigationRepository;
  getDb(): Kysely<Database>;
}

/**
 * Flat row of a node-provenance join (nav (app,build) Phase 2, #4985):
 * navigation_node_observations ⋈ navigation_build_keys. `package_id` is the build
 * key's `app_id`. Grouped per `node_id` by the caller.
 */
export interface NavigationNodeProvenanceRow {
  node_id: number;
  package_id: string;
  version_code: number;
  content_hash: string;
  device_id: string;
  session_uuid: string;
  last_seen_at: number;
}

/**
 * Flat row of an edge-provenance join (#4985), symmetric to
 * {@link NavigationNodeProvenanceRow} but keyed by `edge_id`.
 */
export interface NavigationEdgeProvenanceRow {
  edge_id: number;
  package_id: string;
  version_code: number;
  content_hash: string;
  device_id: string;
  session_uuid: string;
  last_seen_at: number;
}

/**
 * One distinct outgoing transition of a screen, without hydration (see
 * {@link NavigationRepository.getEdgeTargetsFrom}). `toolArgs` is the raw stored JSON
 * string; callers that need it must parse it defensively.
 */
export interface NavigationEdgeTarget {
  toScreen: string;
  toolName: string | null;
  toolArgs: string | null;
}

/** The tool call that produced a navigation edge, when known. */
export interface NavigationEdgeTool {
  toolName: string | null;
  toolArgs: Record<string, any> | null;
}
