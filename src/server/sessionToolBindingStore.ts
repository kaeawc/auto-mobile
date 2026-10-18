/**
 * The keyed half of {@link SessionToolBinding}, lifted out of the per-server
 * instance so a binding outlives the server that recorded it (#4678). A
 * stateless daemon builds one `McpServer` per request, so a device acquired by
 * one request must still be bound on the next request that carries the same
 * session key (`MCP_SESSION_KEY_HEADER` or the in-band `__mcpSessionId`).
 *
 * Only state keyed by a session key lives here. The direct (stdio, keyless)
 * slot and the seeds a server is constructed with stay on the instance: a
 * keyless request has no identity to share a binding across.
 *
 * Release teardown subscribes once per store, not once per server: a released
 * session is cleared from the keyed maps and from every live instance attached
 * to the store, and `onBindingChanged` fires at most once per release.
 */

/** Per-instance state the store clears when a session is released. */
export interface SessionToolBindingLocalState {
  /** Drops this instance's seeded/direct bindings for `sessionUuid`; true when any changed. */
  releaseLocalSession(sessionUuid: string): boolean;
}

export interface SessionToolBindingStoreDeps {
  /** Subscribes `onReleased` to every release source; returns one unsubscribe. */
  readonly subscribeReleases: (onReleased: (sessionUuid: string) => void) => () => void;
  /** Called once per release that actually removed a binding. */
  readonly onBindingChanged: () => void;
}

const INERT_DEPS: SessionToolBindingStoreDeps = {
  subscribeReleases: () => () => {},
  onBindingChanged: () => {},
};

export class SessionToolBindingStore {
  private readonly acquiredSessions = new Map<string, Set<string>>();
  private readonly boundDeviceSessions = new Map<string, string>();
  private readonly releasedDeviceSessions = new Map<string, string>();
  private readonly toolSelectionProfiles = new Map<string, string>();
  private readonly attached = new Set<SessionToolBindingLocalState>();
  private unsubscribeReleases?: () => void;

  constructor(private readonly deps: SessionToolBindingStoreDeps = INERT_DEPS) {}

  /**
   * Attach a live instance so a release also clears its local state. The store
   * subscribes to releases on the first attach and keeps the subscription until
   * {@link dispose}, so a release between two stateless requests still clears
   * the keyed maps. Returns the detach.
   */
  attach(binding: SessionToolBindingLocalState): () => void {
    this.unsubscribeReleases ??= this.deps.subscribeReleases((sessionUuid) => {
      if (this.releaseSession(sessionUuid)) {
        this.deps.onBindingChanged();
      }
    });
    this.attached.add(binding);
    return () => {
      this.attached.delete(binding);
    };
  }

  /** Drop the release subscription and every attached instance. */
  dispose(): void {
    this.unsubscribeReleases?.();
    this.unsubscribeReleases = undefined;
    this.attached.clear();
  }

  boundSessionUuid(key: string): string | undefined {
    return this.boundDeviceSessions.get(key);
  }

  releasedSessionUuid(key: string): string | undefined {
    return this.releasedDeviceSessions.get(key);
  }

  acquiredSessionUuids(key: string): ReadonlySet<string> {
    return this.acquiredSessions.get(key) ?? new Set();
  }

  toolSelectionProfileUuid(key: string): string | undefined {
    return this.toolSelectionProfiles.get(key);
  }

  /** Records `sessionUuid` as acquired and bound for `key`; true when the bound session changed. */
  bind(key: string, sessionUuid: string): boolean {
    let acquired = this.acquiredSessions.get(key);
    if (!acquired) {
      acquired = new Set<string>();
      this.acquiredSessions.set(key, acquired);
    }
    acquired.add(sessionUuid);
    if (this.boundDeviceSessions.get(key) === sessionUuid) {
      return false;
    }
    this.boundDeviceSessions.set(key, sessionUuid);
    this.releasedDeviceSessions.delete(key);
    return true;
  }

  /** True when the profile changed. */
  bindToolSelectionProfile(key: string, profileUuid: string): boolean {
    if (this.toolSelectionProfiles.get(key) === profileUuid) {
      return false;
    }
    this.toolSelectionProfiles.set(key, profileUuid);
    return true;
  }

  /**
   * Forget every binding recorded for `key`: the caller that owns the key (the
   * socket session, the desktop app session) has gone, so nothing will present
   * it again. Not a release: the sessions themselves stay live.
   */
  forget(key: string): void {
    this.acquiredSessions.delete(key);
    this.boundDeviceSessions.delete(key);
    this.releasedDeviceSessions.delete(key);
    this.toolSelectionProfiles.delete(key);
  }

  /**
   * Drop every binding whose session is the released `sessionUuid` (#4611 Gap D),
   * in the keyed maps and in every attached instance. Idempotent: true only when
   * something was removed, so a duplicate release signal is a no-op.
   */
  releaseSession(sessionUuid: string): boolean {
    if (!sessionUuid) {
      return false;
    }
    let removed = false;
    for (const [key, acquired] of this.acquiredSessions) {
      removed = acquired.delete(sessionUuid) || removed;
      if (acquired.size === 0) {
        this.acquiredSessions.delete(key);
      }
    }
    for (const [key, boundSessionUuid] of this.boundDeviceSessions) {
      if (boundSessionUuid === sessionUuid) {
        this.boundDeviceSessions.delete(key);
        this.releasedDeviceSessions.set(key, sessionUuid);
        removed = true;
      }
    }
    for (const binding of this.attached) {
      removed = binding.releaseLocalSession(sessionUuid) || removed;
    }
    return removed;
  }
}
