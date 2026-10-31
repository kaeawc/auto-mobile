import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type {
  Database,
  PrototypeTestSessionsTable,
  PrototypeTestSessionEventsTable,
} from "./types";
import type { RepositoryDeps } from "./repositoryDeps";

/** The device (and optional routing session) a test session is looked up for. */
export interface PrototypeTestSessionScope {
  sessionUuid?: string;
  deviceId: string;
}
export const MAX_EVENTS_PER_TEST_SESSION = 5000;
export type TestSession = PrototypeTestSessionsTable;
export type TestSessionEvent = PrototypeTestSessionEventsTable;
export type NewTestSessionEvent = Omit<TestSessionEvent, "test_session_id" | "seq">;
export type EndedReason = NonNullable<TestSession["ended_reason"]>;
export interface PrototypeTestSessionStore {
  insertSession(session: TestSession): Promise<void>;
  /** Device-wide active ownership, across routing sessions. */
  findActive(scope: PrototypeTestSessionScope, id: string): Promise<TestSession | undefined>;
  findById(id: string): Promise<TestSession | undefined>;
  findLatest(scope: PrototypeTestSessionScope, id: string): Promise<TestSession | undefined>;
  appendEvents(id: string, rows: readonly NewTestSessionEvent[]): Promise<void>;
  endSession(id: string, endedAtMs: number, reason: EndedReason): Promise<void>;
  listEvents(id: string): Promise<TestSessionEvent[]>;
  pruneEnded(keep?: number): Promise<void>;
}
export class PrototypeTestSessionRepository implements PrototypeTestSessionStore {
  private readonly db?: Kysely<Database>;

  constructor({ db }: Pick<RepositoryDeps, "db"> = {}) {
    this.db = db;
  }
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }
  async insertSession(session: TestSession): Promise<void> {
    await this.getDb().insertInto("prototype_test_sessions").values(session).execute();
  }
  findActive(scope: PrototypeTestSessionScope, id: string): Promise<TestSession | undefined> {
    return this.getDb()
      .selectFrom("prototype_test_sessions")
      .selectAll()
      .where("device_id", "=", scope.deviceId)
      .where("prototype_id", "=", id)
      .where("status", "=", "active")
      .executeTakeFirst();
  }
  findById(id: string): Promise<TestSession | undefined> {
    return this.getDb()
      .selectFrom("prototype_test_sessions")
      .selectAll()
      .where("test_session_id", "=", id)
      .executeTakeFirst();
  }
  findLatest(scope: PrototypeTestSessionScope, id: string): Promise<TestSession | undefined> {
    return this.getDb()
      .selectFrom("prototype_test_sessions")
      .selectAll()
      .where("device_id", "=", scope.deviceId)
      .where("prototype_id", "=", id)
      .where(
        "session_uuid",
        scope.sessionUuid === undefined ? "is" : "=",
        scope.sessionUuid ?? null,
      )
      .orderBy("started_at_ms", "desc")
      .orderBy("test_session_id", "desc")
      .executeTakeFirst();
  }
  async appendEvents(id: string, rows: readonly NewTestSessionEvent[]): Promise<void> {
    await this.getDb()
      .transaction()
      .execute(async (db) => {
        const session = await db
          .selectFrom("prototype_test_sessions")
          .select("status")
          .where("test_session_id", "=", id)
          .executeTakeFirstOrThrow();
        if (session.status !== "active") {
          return;
        }
        const count = await db
          .selectFrom("prototype_test_session_steps")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("test_session_id", "=", id)
          .executeTakeFirstOrThrow();
        const accepted = rows.slice(
          0,
          Math.max(0, MAX_EVENTS_PER_TEST_SESSION - Number(count.count)),
        );
        // Stay below SQLite's parameter limit even when callers flush a full session at once.
        for (let offset = 0; offset < accepted.length; offset += 100) {
          await db
            .insertInto("prototype_test_session_steps")
            .values(
              accepted.slice(offset, offset + 100).map((row, index) => ({
                ...row,
                test_session_id: id,
                seq: Number(count.count) + offset + index + 1,
              })),
            )
            .execute();
        }
        if (accepted.length < rows.length) {
          await db
            .updateTable("prototype_test_sessions")
            .set((eb) => ({
              dropped_count: eb("dropped_count", "+", rows.length - accepted.length),
            }))
            .where("test_session_id", "=", id)
            .execute();
        }
      });
  }
  async endSession(id: string, endedAtMs: number, reason: EndedReason): Promise<void> {
    await this.getDb()
      .updateTable("prototype_test_sessions")
      .set({ status: "ended", ended_at_ms: endedAtMs, ended_reason: reason })
      .where("test_session_id", "=", id)
      .where("status", "=", "active")
      .execute();
  }
  listEvents(id: string): Promise<TestSessionEvent[]> {
    return this.getDb()
      .selectFrom("prototype_test_session_steps")
      .selectAll()
      .where("test_session_id", "=", id)
      .orderBy("seq")
      .execute();
  }
  async pruneEnded(keep = 50): Promise<void> {
    await this.getDb()
      .transaction()
      .execute(async (db) => {
        const ended = await db
          .selectFrom("prototype_test_sessions")
          .selectAll()
          .where("status", "=", "ended")
          .orderBy("ended_at_ms", "desc")
          .orderBy("test_session_id", "desc")
          .execute();
        const counts = new Map<string, number>();
        for (const session of ended) {
          const key = JSON.stringify([session.device_id, session.prototype_id]);
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          if (count > Math.max(0, keep)) {
            await db
              .deleteFrom("prototype_test_session_steps")
              .where("test_session_id", "=", session.test_session_id)
              .execute();
            await db
              .deleteFrom("prototype_test_sessions")
              .where("test_session_id", "=", session.test_session_id)
              .execute();
          }
        }
      });
  }
}
