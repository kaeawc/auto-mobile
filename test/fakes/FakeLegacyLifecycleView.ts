import type { LegacyLifecycleView } from "../../src/daemon/sessionSlots";

/** Deterministic stand-in for a collected WeakRef; never depends on garbage collection. */
export function deadIdentity(): { deref(): object | undefined } {
  return { deref: () => undefined };
}

export class FakeLegacyLifecycleView implements LegacyLifecycleView {
  readonly releasingSessions = new WeakSet<object>();

  isReleasing(session: object): boolean {
    return this.releasingSessions.has(session);
  }

  readonly sessions = new Map<string, object>();
  readonly pendingAssignments = new Map<string, unknown>();
  readonly pendingCreations = new Map<string, unknown>();
  readonly pendingReleases = new Map<string, unknown>();
  readonly pendingRebinds = new Map<string, unknown>();
  readonly releaseOps = new Map<
    string,
    { session: object; forced?: boolean; commitDeclined?: boolean }
  >();
  readonly terminalSnapshots = new Map<string, unknown>();
  readonly recoveredTerminalIntents = new Map<string, unknown>();
  readonly latestFinalizedIdentities = new Map<string, { deref(): object | undefined }>();

  publish(uuid: string, session: object = {}): this {
    this.sessions.set(uuid, session);
    return this;
  }

  unpublish(uuid: string): this {
    this.sessions.delete(uuid);
    return this;
  }

  startCreation(uuid: string): this {
    this.pendingCreations.set(uuid, {});
    return this;
  }

  startAssignment(uuid: string): this {
    this.pendingAssignments.set(uuid, {});
    return this;
  }

  requestRelease(uuid: string): this {
    this.pendingReleases.set(uuid, {});
    return this;
  }

  startRebind(uuid: string): this {
    this.pendingRebinds.set(uuid, {});
    return this;
  }

  startRelease(uuid: string, options: { forced?: boolean; commitDeclined?: boolean } = {}): this {
    const session = this.sessions.get(uuid) ?? {};
    this.releaseOps.set(uuid, { session, ...options });
    if (options.forced) {
      this.sessions.delete(uuid);
    }
    return this;
  }

  fenceTerminal(uuid: string): this {
    this.terminalSnapshots.set(uuid, {});
    return this;
  }

  recoverIntent(uuid: string): this {
    this.recoveredTerminalIntents.set(uuid, {});
    return this;
  }

  finalize(uuid: string, identity: { deref(): object | undefined }): this {
    this.latestFinalizedIdentities.set(uuid, identity);
    return this;
  }
}
