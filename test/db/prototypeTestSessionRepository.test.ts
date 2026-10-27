import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import {
  PrototypeTestSessionRepository,
  MAX_EVENTS_PER_TEST_SESSION,
  type TestSession,
} from "../../src/db/prototypeTestSessionRepository";
import { createTestDatabase } from "./testDbHelper";
const session: TestSession = {
  test_session_id: "test",
  prototype_id: "panel",
  device_id: "device",
  session_uuid: null,
  cohort: null,
  goal: null,
  start_screen: "(root)",
  status: "active",
  started_at_ms: 0,
  ended_at_ms: null,
  ended_reason: null,
  dropped_count: 0,
};
const row = {
  event_sequence: 1,
  at_ms: 5,
  kind: "emit",
  name: "save",
  screen: "(root)",
  detail_json: "{}",
};
let db: Kysely<Database>, repository: PrototypeTestSessionRepository;
beforeEach(async () => {
  db = await createTestDatabase({ foreignKeys: true });
  repository = new PrototypeTestSessionRepository(db);
});
afterEach(async () => {
  await db.destroy();
});
test("migration registered, persistence scoped, ordered, capped and dropped rows counted", async () => {
  await repository.insertSession(session);
  await repository.appendEvents(
    "test",
    Array.from({ length: MAX_EVENTS_PER_TEST_SESSION + 2 }, (_, i) => ({
      ...row,
      event_sequence: i + 1,
    })),
  );
  await repository.appendEvents("test", [row]);
  const events = await repository.listEvents("test");
  expect(events).toHaveLength(5000);
  expect(events[0]?.seq).toBe(1);
  expect(events.at(-1)?.event_sequence).toBe(5000);
  expect((await repository.findById("test"))?.dropped_count).toBe(3);
  expect(
    await repository.findLatest({ deviceId: "device", sessionUuid: "other" }, "panel"),
  ).toBeUndefined();
  expect(
    (await repository.findActive({ deviceId: "device", sessionUuid: "other" }, "panel"))
      ?.test_session_id,
  ).toBe("test");
});
test("ending is idempotent, ended sessions do not accept more rows, pruning retains per-device/prototype newest", async () => {
  for (let i = 0; i < 4; i++) {
    const id = `test${i}`;
    await repository.insertSession({ ...session, test_session_id: id, started_at_ms: i });
    await repository.appendEvents(id, [row]);
    await repository.endSession(id, i + 10, "end");
    await repository.endSession(id, 999, "dismissed");
  }
  await repository.insertSession({ ...session, test_session_id: "active" });
  await repository.insertSession({ ...session, test_session_id: "other", device_id: "other" });
  await repository.endSession("other", 0, "released");
  await repository.appendEvents("test3", [row]);
  expect(await repository.listEvents("test3")).toHaveLength(1);
  await repository.pruneEnded(2);
  expect(await repository.findById("test0")).toBeUndefined();
  expect(await repository.listEvents("test0")).toEqual([]);
  expect((await repository.findLatest({ deviceId: "device" }, "panel"))?.test_session_id).toBe(
    "test3",
  );
  expect((await repository.findById("test3"))?.ended_at_ms).toBe(13);
  expect(await repository.findById("active")).toBeDefined();
  expect(await repository.findById("other")).toBeDefined();
});
