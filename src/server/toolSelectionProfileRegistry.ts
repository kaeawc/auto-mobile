import {
  ToolSelectionProfileProvenanceRepository,
  type ToolSelectionProfileProvenanceStore,
} from "../db/toolSelectionProfileProvenanceRepository";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";

export type { ToolSelectionProfileProvenanceStore };

/**
 * Tracks tool-selection-profile identifiers this daemon PROCESS itself has
 * minted via `SessionToolBinding.createAndBindToolSelectionProfile` — the
 * single source of truth for "was this uuid actually server-issued",
 * independent of which ephemeral internal loopback MCP session handles a
 * later request that reaffirms it.
 *
 * #6148 round 4: round 3's `SessionToolBinding.isServerIssuedToolSelectionProfile`
 * checked membership in a map keyed by the exact `mcpSessionId` that minted the
 * profile. That works in direct/stdio mode (one long-lived `createMcpServer()`
 * instance), but the DEFAULT deployment is the daemon-proxy loopback topology
 * (`src/server/proxyServer.ts` -> `DaemonMcpProxy` -> `src/daemon/socketServer.ts`
 * -> an internal HTTP client back into this same server): a call that omits
 * `sessionUuid` (mint) and a later call that explicitly reaffirms the minted
 * uuid are routed through DIFFERENT internal client keys
 * (`sharedMcpForwardRoute` vs `sessionScopedForwardRoute`/
 * `toolSelectionProfileScopedForwardRoute` in socketServer.ts), each of which
 * gets its OWN `createMcpServer()` call and therefore its own, unrelated
 * `SessionToolBinding` instance with an empty local map — so the per-instance
 * check always failed after crossing that hop, breaking the legitimate
 * self-reaffirm path (round 3's own fix for #6148 P2).
 *
 * This registry is process-wide instead of per-instance, so it survives that
 * hop: every `createMcpServer()` call in one daemon process shares the same
 * registry (the default export below), so a profile minted on one internal
 * session is still recognized on another. A profile-uuid is a crypto-random
 * value (`IdGenerator`), so membership is as strong a provenance signal as any
 * other bearer identifier in this codebase — no external caller can produce a
 * colliding value, and only `createAndBindToolSelectionProfile`'s call site
 * ever writes to it. The unauthenticated header/`initialToolSelectionProfileUuid`
 * fallback that caused round 2's spoofing hole is never recorded here, so a
 * fabricated or merely-echoed-header value still fails this check.
 *
 * Tradeoff: entries are never pruned, so a daemon's uptime bounds how large
 * this set grows (one entry per anonymous `setToolEnabled` call across the
 * daemon's life) — the same unpruned-growth characteristic the persistent
 * `session_tool_overrides` table already has for the same feature. Acceptable
 * for now; revisit with an eviction policy if it matters in practice.
 */
export interface ToolSelectionProfileRegistry {
  /** Record a profile-uuid this process itself minted via createAndBindToolSelectionProfile. */
  record(profileUuid: string): void;
  /** True only for a uuid previously passed to `record`. */
  has(profileUuid: string): boolean;
}

/**
 * Loads previously-minted provenance into a registry (issue #6225). Narrow on
 * purpose (YAGNI): the daemon startup path is the only consumer, and it needs
 * nothing beyond "make persisted membership visible to `has()`".
 */
export interface ToolSelectionProfileProvenanceLoader {
  /**
   * Populate the registry's in-memory membership from durable storage. Never
   * throws — a load failure (or a fresh/empty store) leaves the registry
   * exactly as it was pre-#6225: empty, so an old profile must re-mint.
   */
  load(): Promise<void>;
}

export class InMemoryToolSelectionProfileRegistry implements ToolSelectionProfileRegistry {
  private readonly minted = new Set<string>();

  record(profileUuid: string): void {
    if (profileUuid.trim().length > 0) {
      this.minted.add(profileUuid);
    }
  }

  has(profileUuid: string): boolean {
    return this.minted.has(profileUuid);
  }
}

/**
 * Durable-backed registry (issue #6225, #6148/#6213 follow-up): wraps an
 * in-memory `InMemoryToolSelectionProfileRegistry` (so `has()`/`record()` stay
 * synchronous and every existing call site is unchanged) and write-throughs
 * every mint to `ToolSelectionProfileProvenanceRepository`, so a legitimately
 * minted profile is recognized again after a daemon restart/upgrade once
 * `load()` has repopulated the in-memory set.
 *
 * The write-through is fire-and-forget from the CALLER's perspective (`record()`
 * stays synchronous), but it is NOT untracked: it is routed through the shared
 * `DbWriteBarrier` (`getDbWriteBarrier().track(...)`, resolved fresh per call
 * per the barrier's use-time-resolution contract), the same barrier
 * `Daemon.stop()`'s graceful-shutdown drain awaits before closing the database
 * (issue #2792's mechanism). Without this, a restart during a slow/queued
 * SQLite write could have the drain see no outstanding work and close the DB
 * before the insert commits — the repository would then swallow that failure,
 * and the very next daemon would reject the profile this PR is meant to let it
 * recognize. The repository still logs and swallows its OWN failures (matching
 * `DeviceLockRepository`'s best-effort convention), so a genuine persistence
 * failure (not a race with shutdown) degrades to the pre-#6225 in-memory-only
 * behavior for that one entry rather than failing the `setToolEnabled` call
 * that triggered the mint. A value that is never inserted — a fabricated or
 * merely-echoed-header uuid — is never recorded here either, so it is
 * rejected identically before and after a restart.
 */
export class PersistentToolSelectionProfileRegistry
  implements ToolSelectionProfileRegistry, ToolSelectionProfileProvenanceLoader
{
  private readonly memory = new InMemoryToolSelectionProfileRegistry();

  constructor(private readonly repository: ToolSelectionProfileProvenanceStore) {}

  record(profileUuid: string): void {
    this.memory.record(profileUuid);
    if (profileUuid.trim().length > 0) {
      void getDbWriteBarrier().track(() => this.repository.insert(profileUuid));
    }
  }

  has(profileUuid: string): boolean {
    return this.memory.has(profileUuid);
  }

  async load(): Promise<void> {
    const persisted = await this.repository.loadAll();
    for (const profileUuid of persisted) {
      this.memory.record(profileUuid);
    }
  }
}

/**
 * Production default: shared across every `createMcpServer()` call made
 * within this daemon process, so it survives the loopback-proxy hop. Tests
 * that construct multiple `createMcpServer()` instances to simulate that hop
 * must inject one explicit shared instance via
 * `McpServerOptions.toolSelectionProfileRegistry` instead of relying on this
 * module singleton, for isolation from other test files sharing the process.
 *
 * Typed as the intersection so daemon startup can call `.load()` (issue #6225)
 * while every other consumer keeps using the narrower `ToolSelectionProfileRegistry`
 * interface.
 */
export const defaultToolSelectionProfileRegistry: ToolSelectionProfileRegistry &
  ToolSelectionProfileProvenanceLoader = new PersistentToolSelectionProfileRegistry(
  new ToolSelectionProfileProvenanceRepository(),
);
