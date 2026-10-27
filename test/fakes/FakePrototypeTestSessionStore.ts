import {
  MAX_EVENTS_PER_TEST_SESSION,
  type PrototypeTestSessionStore,
  type TestSession,
  type TestSessionEvent,
  type NewTestSessionEvent,
  type EndedReason,
} from "../../src/db/prototypeTestSessionRepository";
import type { PrototypeScope } from "../../src/features/prototype/PrototypeStatusStore";

export class FakePrototypeTestSessionStore implements PrototypeTestSessionStore {
  readonly sessions = new Map<string, TestSession>();
  readonly events = new Map<string, TestSessionEvent[]>();
  failure?: Error;
  private check(): void {
    if (this.failure) {
      throw this.failure;
    }
  }
  async insertSession(session: TestSession): Promise<void> {
    this.check();
    this.sessions.set(session.test_session_id, structuredClone(session));
  }
  async findActive(scope: PrototypeScope, id: string): Promise<TestSession | undefined> {
    this.check();
    return structuredClone(
      [...this.sessions.values()].find(
        (s) => s.device_id === scope.deviceId && s.prototype_id === id && s.status === "active",
      ),
    );
  }
  async findById(id: string): Promise<TestSession | undefined> {
    this.check();
    return structuredClone(this.sessions.get(id));
  }
  async findLatest(scope: PrototypeScope, id: string): Promise<TestSession | undefined> {
    this.check();
    return structuredClone(
      [...this.sessions.values()]
        .filter(
          (s) =>
            s.device_id === scope.deviceId &&
            s.prototype_id === id &&
            s.session_uuid === (scope.sessionUuid ?? null),
        )
        .sort(
          (a, b) =>
            b.started_at_ms - a.started_at_ms || b.test_session_id.localeCompare(a.test_session_id),
        )[0],
    );
  }
  async appendEvents(id: string, rows: readonly NewTestSessionEvent[]): Promise<void> {
    this.check();
    const session = this.sessions.get(id);
    if (!session || session.status !== "active") {
      return;
    }
    const events = this.events.get(id) ?? [];
    const accepted = rows.slice(0, Math.max(0, MAX_EVENTS_PER_TEST_SESSION - events.length));
    for (const row of accepted) {
      events.push({ ...structuredClone(row), test_session_id: id, seq: events.length + 1 });
    }
    session.dropped_count += rows.length - accepted.length;
    this.events.set(id, events);
  }
  async endSession(id: string, at: number, reason: EndedReason): Promise<void> {
    this.check();
    const s = this.sessions.get(id);
    if (s?.status === "active") {
      s.status = "ended";
      s.ended_at_ms = at;
      s.ended_reason = reason;
    }
  }
  async listEvents(id: string): Promise<TestSessionEvent[]> {
    this.check();
    return structuredClone(this.events.get(id) ?? []);
  }
  async pruneEnded(keep = 50): Promise<void> {
    this.check();
    const counts = new Map<string, number>();
    const ended = [...this.sessions.values()]
      .filter((s) => s.status === "ended")
      .sort(
        (a, b) =>
          (b.ended_at_ms ?? 0) - (a.ended_at_ms ?? 0) ||
          b.test_session_id.localeCompare(a.test_session_id),
      );
    for (const s of ended) {
      const key = JSON.stringify([s.device_id, s.prototype_id]);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > Math.max(0, keep)) {
        this.sessions.delete(s.test_session_id);
        this.events.delete(s.test_session_id);
      }
    }
  }
}
