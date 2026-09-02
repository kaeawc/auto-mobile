import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely as KyselyRuntime, sql, type Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import {
  FailureAnalyticsRepository,
  mergeScreenBreakdownRows,
} from "../../src/db/failureAnalyticsRepository";
import type { RecordFailureInput } from "../../src/db/failureAnalyticsRepository";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations } from "../../src/db/migrator";
import { createTestDatabase } from "./testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

describe("FailureAnalyticsRepository", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: FailureAnalyticsRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1000000);
    repo = new FailureAnalyticsRepository(timer, db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  function makeFailureInput(overrides: Partial<RecordFailureInput> = {}): RecordFailureInput {
    return {
      type: "crash",
      signature: "com.example.NullPointerException@MainActivity.onCreate",
      title: "NullPointerException in MainActivity",
      message: "Attempt to invoke method on null reference",
      severity: "critical",
      occurrence: {
        deviceModel: "Pixel 7",
        os: "Android 14",
        appVersion: "1.0.0",
        sessionId: "session-1",
      },
      ...overrides,
    };
  }

  describe("recordFailure", () => {
    test("creates a group and occurrence on first failure", async () => {
      const occurrenceId = await repo.recordFailure(makeFailureInput());

      expect(occurrenceId).toBeDefined();
      expect(typeof occurrenceId).toBe("string");

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("crash");
      expect(groups[0].signature).toBe("com.example.NullPointerException@MainActivity.onCreate");
      expect(groups[0].title).toBe("NullPointerException in MainActivity");
      expect(groups[0].total_count).toBe(1);
      expect(groups[0].unique_sessions).toBe(1);

      const occurrences = await db.selectFrom("failure_occurrences").selectAll().execute();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].id).toBe(occurrenceId);
      expect(occurrences[0].device_model).toBe("Pixel 7");
      expect(occurrences[0].os).toBe("Android 14");
    });

    test("creates a notification for streaming", async () => {
      await repo.recordFailure(makeFailureInput());

      const notifications = await db.selectFrom("failure_notifications").selectAll().execute();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe("crash");
      expect(notifications[0].severity).toBe("critical");
      expect(notifications[0].acknowledged).toBe(0);
    });

    test("uses injected IdGenerator for persisted IDs", async () => {
      const idGenerator = new FakeIdGenerator(["occurrence-id", "group-id", "capture-id"]);
      const deterministicRepo = new FailureAnalyticsRepository(
        timer,
        db,
        () => new FakeDbWriteBarrier(),
        idGenerator,
      );

      const occurrenceId = await deterministicRepo.recordFailure(
        makeFailureInput({
          capture: {
            type: "screenshot",
            path: "/tmp/screenshot.png",
          },
        }),
      );

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      const occurrences = await db.selectFrom("failure_occurrences").selectAll().execute();
      const captures = await db.selectFrom("failure_captures").selectAll().execute();

      expect(occurrenceId).toBe("occurrence-id");
      expect(groups[0].id).toBe("group-id");
      expect(occurrences[0].id).toBe("occurrence-id");
      expect(captures[0].id).toBe("capture-id");
      expect(idGenerator.pendingCount()).toBe(0);
    });

    test("updates group count on second occurrence with same signature", async () => {
      await repo.recordFailure(makeFailureInput());

      timer.advanceTime(5000);

      await repo.recordFailure(
        makeFailureInput({
          occurrence: {
            deviceModel: "Pixel 8",
            os: "Android 14",
            appVersion: "1.0.1",
            sessionId: "session-2",
          },
        }),
      );

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups).toHaveLength(1);
      expect(groups[0].total_count).toBe(2);
      expect(groups[0].unique_sessions).toBe(2);

      const occurrences = await db.selectFrom("failure_occurrences").selectAll().execute();
      expect(occurrences).toHaveLength(2);
    });

    test("does not increment unique_sessions for same session", async () => {
      await repo.recordFailure(makeFailureInput());

      timer.advanceTime(1000);

      await repo.recordFailure(
        makeFailureInput({
          occurrence: {
            deviceModel: "Pixel 7",
            os: "Android 14",
            appVersion: "1.0.0",
            sessionId: "session-1",
          },
        }),
      );

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups[0].total_count).toBe(2);
      expect(groups[0].unique_sessions).toBe(1);
    });

    test("records capture when provided", async () => {
      await repo.recordFailure(
        makeFailureInput({
          capture: {
            type: "screenshot",
            path: "/tmp/screenshot.png",
          },
        }),
      );

      const captures = await db.selectFrom("failure_captures").selectAll().execute();
      expect(captures).toHaveLength(1);
      expect(captures[0].type).toBe("screenshot");
      expect(captures[0].path).toBe("/tmp/screenshot.png");
    });

    test("records screens visited", async () => {
      await repo.recordFailure(
        makeFailureInput({
          occurrence: {
            deviceModel: "Pixel 7",
            os: "Android 14",
            appVersion: "1.0.0",
            sessionId: "session-1",
            screensVisited: ["Login", "Home", "Settings"],
          },
        }),
      );

      const screens = await db
        .selectFrom("failure_occurrence_screens")
        .selectAll()
        .orderBy("visit_order", "asc")
        .execute();
      expect(screens).toHaveLength(3);
      expect(screens[0].screen_name).toBe("Login");
      expect(screens[1].screen_name).toBe("Home");
      expect(screens[2].screen_name).toBe("Settings");
    });

    test("rolls back the group count when the occurrence insert fails", async () => {
      await repo.recordFailure(makeFailureInput());
      const originalGroup = await db
        .selectFrom("failure_groups")
        .selectAll()
        .executeTakeFirstOrThrow();
      await sql`
        CREATE TEMP TRIGGER fail_failure_occurrence_insert
        BEFORE INSERT ON failure_occurrences
        BEGIN
          SELECT RAISE(ABORT, 'forced occurrence insert failure');
        END
      `.execute(db);

      await expect(
        repo.recordFailure(
          makeFailureInput({
            capture: {
              type: "screenshot",
              path: "/tmp/failed-screenshot.png",
            },
            occurrence: {
              deviceModel: "Pixel 8",
              os: "Android 15",
              appVersion: "2.0.0",
              sessionId: "session-2",
              screensVisited: ["Home", "FailureDetails"],
            },
          }),
        ),
      ).rejects.toThrow("forced occurrence insert failure");

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups).toHaveLength(1);
      expect(groups[0]).toEqual(originalGroup);

      expect(await db.selectFrom("failure_occurrences").selectAll().execute()).toHaveLength(1);
      expect(await db.selectFrom("failure_occurrence_screens").selectAll().execute()).toHaveLength(
        0,
      );
      expect(await db.selectFrom("failure_captures").selectAll().execute()).toHaveLength(0);
      expect(await db.selectFrom("failure_notifications").selectAll().execute()).toHaveLength(1);
    });

    test("rolls back occurrence detail rows when notification insert fails", async () => {
      await sql`
        CREATE TEMP TRIGGER fail_failure_notification_insert
        BEFORE INSERT ON failure_notifications
        BEGIN
          SELECT RAISE(ABORT, 'forced notification insert failure');
        END
      `.execute(db);

      await expect(
        repo.recordFailure(
          makeFailureInput({
            capture: {
              type: "screenshot",
              path: "/tmp/failed-notification.png",
            },
            occurrence: {
              deviceModel: "Pixel 8",
              os: "Android 15",
              appVersion: "2.0.0",
              sessionId: "session-2",
              screensVisited: ["Home", "FailureDetails"],
            },
          }),
        ),
      ).rejects.toThrow("forced notification insert failure");

      expect(await db.selectFrom("failure_groups").selectAll().execute()).toHaveLength(0);
      expect(await db.selectFrom("failure_occurrences").selectAll().execute()).toHaveLength(0);
      expect(await db.selectFrom("failure_occurrence_screens").selectAll().execute()).toHaveLength(
        0,
      );
      expect(await db.selectFrom("failure_captures").selectAll().execute()).toHaveLength(0);
      expect(await db.selectFrom("failure_notifications").selectAll().execute()).toHaveLength(0);
    });
  });

  describe("getFailureGroups", () => {
    test("returns all groups unfiltered", async () => {
      await repo.recordFailure(makeFailureInput());

      timer.advanceTime(1000);

      await repo.recordFailure(
        makeFailureInput({
          signature: "com.example.OtherException@OtherActivity",
          title: "OtherException",
          type: "anr",
          severity: "high",
        }),
      );

      const groups = await repo.getFailureGroups();
      expect(groups).toHaveLength(2);
    });

    test("filters by type", async () => {
      await repo.recordFailure(makeFailureInput());

      timer.advanceTime(1000);

      await repo.recordFailure(
        makeFailureInput({
          signature: "com.example.ANR@MainActivity",
          title: "ANR in MainActivity",
          type: "anr",
          severity: "high",
        }),
      );

      const crashGroups = await repo.getFailureGroups({ type: "crash" });
      expect(crashGroups).toHaveLength(1);
      expect(crashGroups[0].type).toBe("crash");

      const anrGroups = await repo.getFailureGroups({ type: "anr" });
      expect(anrGroups).toHaveLength(1);
      expect(anrGroups[0].type).toBe("anr");
    });

    test("filters by severity", async () => {
      await repo.recordFailure(makeFailureInput({ severity: "critical" }));

      timer.advanceTime(1000);

      await repo.recordFailure(
        makeFailureInput({
          signature: "com.example.Warning",
          severity: "low",
        }),
      );

      const criticalGroups = await repo.getFailureGroups({ severity: "critical" });
      expect(criticalGroups).toHaveLength(1);
      expect(criticalGroups[0].severity).toBe("critical");
    });

    test("returns group with correct aggregated fields", async () => {
      await repo.recordFailure(
        makeFailureInput({
          occurrence: {
            deviceModel: "Pixel 7",
            os: "Android 14",
            appVersion: "1.0.0",
            sessionId: "session-1",
            screenAtFailure: "HomeScreen",
          },
        }),
      );

      const groups = await repo.getFailureGroups();
      expect(groups).toHaveLength(1);

      const group = groups[0];
      expect(group.title).toBe("NullPointerException in MainActivity");
      expect(group.totalCount).toBe(1);
      expect(group.uniqueSessions).toBe(1);
      expect(group.deviceBreakdown).toHaveLength(1);
      expect(group.deviceBreakdown[0].deviceModel).toBe("Pixel 7");
      expect(group.versionBreakdown).toHaveLength(1);
      expect(group.versionBreakdown[0].version).toBe("1.0.0");
    });

    test("fetches aggregated group details with a bounded query count and preserves per-group top-N", async () => {
      const instrumented = await createInstrumentedTestDatabase();
      const instrumentedRepo = new FailureAnalyticsRepository(
        timer,
        instrumented.db,
        () => new FakeDbWriteBarrier(),
      );
      try {
        await seedFailureGroup(instrumented.db, {
          id: "group-high-volume",
          signature: "high-volume",
          title: "High volume",
          lastOccurrence: 2000,
          totalCount: 8,
        });
        await seedFailureGroup(instrumented.db, {
          id: "group-quiet",
          signature: "quiet",
          title: "Quiet group",
          lastOccurrence: 1500,
          totalCount: 1,
        });

        for (let i = 0; i < 8; i++) {
          await seedFailureOccurrence(instrumented.db, {
            id: `high-occ-${i}`,
            groupId: "group-high-volume",
            timestamp: 1000 + i,
            deviceModel: i % 2 === 0 ? "Pixel A" : "Pixel B",
            appVersion: `1.0.${i % 2}`,
            screenAtFailure: i % 2 === 0 ? "Home" : "Settings",
            screensVisited: ["Launch", "Home", `Step${i}`],
            capturePath: `/captures/high-${i}.png`,
          });
        }
        await seedFailureOccurrence(instrumented.db, {
          id: "quiet-occ-0",
          groupId: "group-quiet",
          timestamp: 1400,
          deviceModel: "Pixel Quiet",
          appVersion: "2.0.0",
          screenAtFailure: "QuietScreen",
          screensVisited: ["QuietScreen"],
          capturePath: "/captures/quiet.png",
        });

        instrumented.resetQueryCount();
        const groups = await instrumentedRepo.getFailureGroups({ limit: 2 });

        expect(groups.map((group) => group.id)).toEqual(["group-high-volume", "group-quiet"]);
        expect(instrumented.queryCount()).toBeLessThanOrEqual(10);

        const highVolume = groups[0];
        expect(highVolume.sampleOccurrences.map((occ) => occ.id)).toEqual([
          "high-occ-7",
          "high-occ-6",
          "high-occ-5",
          "high-occ-4",
          "high-occ-3",
          "high-occ-2",
        ]);
        expect(highVolume.recentCaptures.map((capture) => capture.path)).toEqual([
          "/captures/high-7.png",
          "/captures/high-6.png",
          "/captures/high-5.png",
          "/captures/high-4.png",
          "/captures/high-3.png",
        ]);
        expect(highVolume.deviceBreakdown.map((row) => row.deviceModel)).toEqual([
          "Pixel A",
          "Pixel B",
        ]);

        const quiet = groups[1];
        expect(quiet.sampleOccurrences.map((occ) => occ.id)).toEqual(["quiet-occ-0"]);
        expect(quiet.recentCaptures.map((capture) => capture.path)).toEqual([
          "/captures/quiet.png",
        ]);
      } finally {
        await instrumented.db.destroy();
      }
    });

    test("chunks more than SQLite's conservative bound-parameter limit without dropping groups", async () => {
      const instrumented = await createInstrumentedTestDatabase();
      const instrumentedRepo = new FailureAnalyticsRepository(
        timer,
        instrumented.db,
        () => new FakeDbWriteBarrier(),
      );
      try {
        for (let i = 0; i < 1005; i++) {
          await seedFailureGroup(instrumented.db, {
            id: `chunk-group-${i.toString().padStart(4, "0")}`,
            signature: `chunk-sig-${i}`,
            title: `Chunk group ${i}`,
            lastOccurrence: 5000 - i,
            totalCount: [997, 998, 999, 1000].includes(i) ? 1 : 0,
          });
        }
        for (const i of [997, 998, 999, 1000]) {
          await seedFailureOccurrence(instrumented.db, {
            id: `chunk-occ-${i}`,
            groupId: `chunk-group-${i.toString().padStart(4, "0")}`,
            timestamp: 5000 - i,
            deviceModel: `Pixel ${i}`,
            appVersion: `9.${i}.0`,
            screenAtFailure: `Screen ${i}`,
            screensVisited: [`Launch ${i}`, `Screen ${i}`],
            capturePath: `/captures/chunk-${i}.png`,
          });
        }

        instrumented.resetQueryCount();
        const groups = await instrumentedRepo.getFailureGroups({ limit: 1005 });

        expect(groups).toHaveLength(1005);
        expect(groups[0].id).toBe("chunk-group-0000");
        expect(groups[1004].id).toBe("chunk-group-1004");
        for (const i of [997, 998, 999, 1000]) {
          const group = groups.find(
            (item) => item.id === `chunk-group-${i.toString().padStart(4, "0")}`,
          );
          expect(group?.deviceBreakdown[0]).toMatchObject({ deviceModel: `Pixel ${i}`, count: 1 });
          expect(group?.versionBreakdown[0]).toMatchObject({ version: `9.${i}.0`, count: 1 });
          expect(group?.screenBreakdown.map((screen) => screen.screenName)).toEqual([
            `Screen ${i}`,
            `Launch ${i}`,
          ]);
          expect(group?.recentCaptures[0].path).toBe(`/captures/chunk-${i}.png`);
          expect(group?.sampleOccurrences[0]).toMatchObject({
            id: `chunk-occ-${i}`,
            screensVisited: [`Launch ${i}`, `Screen ${i}`],
            capturePath: `/captures/chunk-${i}.png`,
          });
        }
      } finally {
        await instrumented.db.destroy();
      }
    });
  });

  describe("mergeScreenBreakdownRows", () => {
    test("preserves failure rows, caps visit-only additions, and handles overlap", () => {
      const rows = mergeScreenBreakdownRows(
        [
          { screenName: "Checkout", failureCount: 2 },
          { screenName: "Settings", failureCount: 1 },
        ],
        [
          { screenName: "Checkout", visitCount: 10 },
          { screenName: "A", visitCount: 1 },
          { screenName: "B", visitCount: 9 },
          { screenName: "C", visitCount: 8 },
          { screenName: "D", visitCount: 7 },
          { screenName: "E", visitCount: 6 },
          { screenName: "F", visitCount: 5 },
          { screenName: "Settings", visitCount: 3 },
        ],
      );

      expect(rows.map((row) => row.screenName)).toEqual([
        "Checkout",
        "B",
        "C",
        "D",
        "E",
        "F",
        "Settings",
      ]);
      expect(rows.find((row) => row.screenName === "Checkout")).toEqual({
        screenName: "Checkout",
        visitCount: 10,
        failureCount: 2,
        visitPercentage: (10 / 49) * 100,
      });
      expect(rows.some((row) => row.screenName === "A")).toBe(false);
      expect(rows.find((row) => row.screenName === "Settings")?.failureCount).toBe(1);
    });
  });

  describe("getNotificationsSince", () => {
    test("returns all notifications when no cursor given", async () => {
      await repo.recordFailure(makeFailureInput());

      timer.advanceTime(1000);

      await repo.recordFailure(
        makeFailureInput({
          signature: "sig-2",
          title: "Second failure",
        }),
      );

      const response = await repo.getNotificationsSince({});
      expect(response.notifications).toHaveLength(2);
      expect(response.lastTimestamp).toBeDefined();
      expect(response.lastId).toBeDefined();
    });

    test("returns notifications after sinceTimestamp and sinceId cursor", async () => {
      await repo.recordFailure(makeFailureInput());

      // Get the cursor from the first batch
      const firstBatch = await repo.getNotificationsSince({});
      expect(firstBatch.notifications).toHaveLength(1);

      timer.advanceTime(5000);

      await repo.recordFailure(
        makeFailureInput({
          signature: "sig-2",
          title: "Second failure",
        }),
      );

      const response = await repo.getNotificationsSince({
        sinceTimestamp: firstBatch.lastTimestamp,
        sinceId: firstBatch.lastId,
      });
      expect(response.notifications).toHaveLength(1);
      expect(response.notifications[0].title).toBe("Second failure");
    });

    test("filters by type", async () => {
      await repo.recordFailure(makeFailureInput({ type: "crash" }));

      timer.advanceTime(1000);

      await repo.recordFailure(
        makeFailureInput({
          signature: "sig-anr",
          type: "anr",
          severity: "high",
        }),
      );

      const response = await repo.getNotificationsSince({ type: "crash" });
      expect(response.notifications).toHaveLength(1);
      expect(response.notifications[0].type).toBe("crash");
    });

    // Bulk-insert notification rows directly. FK enforcement is off in the
    // default test DB, so occurrence_id need not reference a real occurrence;
    // this seeds 501 rows far faster than 501 recordFailure() calls, keeping
    // the ceiling test well under the 100ms budget.
    const seedNotifications = async (count: number): Promise<void> => {
      const rows = Array.from({ length: count }, (_v, i) => ({
        occurrence_id: `occ-${i}`,
        group_id: `grp-${i}`,
        type: "crash",
        severity: "critical",
        title: `Failure ${i}`,
        timestamp: 1000 + i,
        acknowledged: 0,
      }));
      for (let i = 0; i < rows.length; i += 100) {
        await db
          .insertInto("failure_notifications")
          .values(rows.slice(i, i + 100))
          .execute();
      }
    };

    test("clamps an over-max limit down to STREAM_LIMIT_MAX (500)", async () => {
      await seedNotifications(501);

      const response = await repo.getNotificationsSince({ limit: 1000 });

      // Without the clamp a single poll would drain all 501 rows.
      expect(response.notifications).toHaveLength(500);
    });

    test("clamps a zero limit up to 1", async () => {
      await seedNotifications(3);

      const response = await repo.getNotificationsSince({ limit: 0 });

      expect(response.notifications).toHaveLength(1);
    });

    test("clamps a negative limit up to 1", async () => {
      await seedNotifications(3);

      const response = await repo.getNotificationsSince({ limit: -5 });

      expect(response.notifications).toHaveLength(1);
    });

    test("preserves the cursor when the batch is empty so notifications are not replayed", async () => {
      await seedNotifications(2); // timestamps 1000, 1001

      // A cursor past every row yields an empty batch.
      const response = await repo.getNotificationsSince({
        sinceTimestamp: 99999,
        sinceId: 42,
      });

      expect(response.notifications).toHaveLength(0);
      // The cursor must be carried forward, not reset — otherwise the next poll
      // rewinds to the start and replays notifications forever.
      expect(response.lastTimestamp).toBe(99999);
      expect(response.lastId).toBe(42);
    });
  });

  describe("acknowledgeNotifications", () => {
    test("marks notifications as acknowledged", async () => {
      await repo.recordFailure(makeFailureInput());

      timer.advanceTime(1000);

      await repo.recordFailure(
        makeFailureInput({
          signature: "sig-2",
          title: "Second failure",
        }),
      );

      const before = await repo.getNotificationsSince({});
      expect(before.notifications).toHaveLength(2);
      expect(before.notifications[0].acknowledged).toBe(false);
      expect(before.notifications[1].acknowledged).toBe(false);

      // Acknowledge the first notification
      await repo.acknowledgeNotifications([before.notifications[0].id]);

      const after = await repo.getNotificationsSince({});
      const acked = after.notifications.find((n) => n.id === before.notifications[0].id);
      expect(acked!.acknowledged).toBe(true);

      const unacked = after.notifications.find((n) => n.id === before.notifications[1].id);
      expect(unacked!.acknowledged).toBe(false);
    });

    test("filters by acknowledged status", async () => {
      await repo.recordFailure(makeFailureInput());

      timer.advanceTime(1000);

      await repo.recordFailure(
        makeFailureInput({
          signature: "sig-2",
          title: "Second failure",
        }),
      );

      const all = await repo.getNotificationsSince({});
      await repo.acknowledgeNotifications([all.notifications[0].id]);

      const unackedOnly = await repo.getNotificationsSince({ acknowledged: false });
      expect(unackedOnly.notifications).toHaveLength(1);
      expect(unackedOnly.notifications[0].acknowledged).toBe(false);

      const ackedOnly = await repo.getNotificationsSince({ acknowledged: true });
      expect(ackedOnly.notifications).toHaveLength(1);
      expect(ackedOnly.notifications[0].acknowledged).toBe(true);
    });
  });

  describe("shutdown draining (issue #2792)", () => {
    test("routes background retention cleanup through the barrier", async () => {
      const barrier = new FakeDbWriteBarrier();
      const barrierRepo = new FailureAnalyticsRepository(timer, db, () => barrier);

      await barrierRepo.recordFailure(makeFailureInput());

      // The fire-and-forget cleanupRetention() is tracked (exactly once).
      expect(barrier.trackCalls).toBe(1);
      expect(barrier.ranCount).toBe(1);
    });

    test("skips background retention cleanup while draining, still records the failure", async () => {
      const barrier = new FakeDbWriteBarrier();
      barrier.beginDrain();
      const barrierRepo = new FailureAnalyticsRepository(timer, db, () => barrier);

      const occurrenceId = await barrierRepo.recordFailure(makeFailureInput());

      // The foreground failure write still lands...
      expect(typeof occurrenceId).toBe("string");
      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups).toHaveLength(1);
      // ...but the background cleanup was short-circuited by the drain.
      expect(barrier.trackCalls).toBe(1);
      expect(barrier.ranCount).toBe(0);
    });
  });

  // Regression coverage for #2789: recordFailure() must be an atomic upsert so a
  // burst of same-signature failures collapses to a single group with a correct
  // total_count and a derived unique_sessions. These run against the real
  // in-memory bun:sqlite from createTestDatabase(), where the single-connection
  // mutex genuinely releases across awaits — so the get-or-create version of
  // recordFailure() FAILS these (duplicate groups + lost increments) and the
  // atomic upsert passes. Deterministic (no sleeps), < 100ms.
  describe("recordFailure concurrency (#2789)", () => {
    test("N concurrent calls for one signature yield exactly one group with total_count === N", async () => {
      const N = 20;
      await Promise.all(
        Array.from({ length: N }, (_unused, i) =>
          repo.recordFailure(
            makeFailureInput({
              occurrence: {
                deviceModel: "Pixel 7",
                os: "Android 14",
                appVersion: "1.0.0",
                sessionId: `session-${i}`,
              },
            }),
          ),
        ),
      );

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups).toHaveLength(1);
      expect(groups[0].total_count).toBe(N);

      const occurrences = await db.selectFrom("failure_occurrences").selectAll().execute();
      expect(occurrences).toHaveLength(N);
    });

    test("N concurrent calls spanning M distinct sessions yield unique_sessions === M (derived, not incremented)", async () => {
      const N = 24;
      const M = 6;
      await Promise.all(
        Array.from({ length: N }, (_unused, i) =>
          repo.recordFailure(
            makeFailureInput({
              occurrence: {
                deviceModel: "Pixel 7",
                os: "Android 14",
                appVersion: "1.0.0",
                sessionId: `session-${i % M}`,
              },
            }),
          ),
        ),
      );

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups).toHaveLength(1);
      expect(groups[0].total_count).toBe(N);
      expect(groups[0].unique_sessions).toBe(M);

      // Assert it is genuinely derived from committed occurrences, not an
      // increment on a stale read.
      const distinct = await db
        .selectFrom("failure_occurrences")
        .select("session_id")
        .where("group_id", "=", groups[0].id)
        .distinct()
        .execute();
      expect(distinct).toHaveLength(M);
    });

    test("concurrent same-signature bursts across distinct signatures keep each group isolated", async () => {
      const perSignature = 8;
      const signatures = ["sig-a", "sig-b", "sig-c"];
      await Promise.all(
        signatures.flatMap((sig) =>
          Array.from({ length: perSignature }, (_unused, i) =>
            repo.recordFailure(
              makeFailureInput({
                signature: sig,
                occurrence: {
                  deviceModel: "Pixel 7",
                  os: "Android 14",
                  appVersion: "1.0.0",
                  sessionId: `session-${i}`,
                },
              }),
            ),
          ),
        ),
      );

      const groups = await db
        .selectFrom("failure_groups")
        .selectAll()
        .orderBy("signature", "asc")
        .execute();
      expect(groups).toHaveLength(signatures.length);
      for (const group of groups) {
        expect(group.total_count).toBe(perSignature);
        expect(group.unique_sessions).toBe(perSignature);
      }
    });

    function toolFailureInput(i: number): RecordFailureInput {
      return makeFailureInput({
        type: "tool_failure",
        signature: "tapOn::element_not_found",
        toolCallInfo: {
          toolName: "tapOn",
          errorCodes: { ELEMENT_NOT_FOUND: 1 },
          parameterVariants: { selector: [`btn-${i}`] },
          durationStats: { minMs: 10, maxMs: 10, avgMs: 10, medianMs: 10, p95Ms: 10 },
        },
        occurrence: {
          deviceModel: "Pixel 7",
          os: "Android 14",
          appVersion: "1.0.0",
          sessionId: `session-${i}`,
          errorCode: "ELEMENT_NOT_FOUND",
        },
      });
    }

    // N == 10 keeps every distinct selector inside mergeToolCallInfo's 10-variant
    // cap, so a lossless merge yields exactly 10 selectors and an error count of 10.
    test("merges tool-call-info losslessly across SERIAL tool_failure occurrences", async () => {
      const N = 10;
      for (let i = 0; i < N; i++) {
        await repo.recordFailure(toolFailureInput(i));
      }

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups).toHaveLength(1);
      expect(groups[0].total_count).toBe(N);

      const toolInfo = JSON.parse(groups[0].tool_call_info_json ?? "{}");
      expect(toolInfo.toolName).toBe("tapOn");
      expect(toolInfo.errorCodes.ELEMENT_NOT_FOUND).toBe(N);
      expect(new Set(toolInfo.parameterVariants.selector).size).toBe(N);
    });

    // The merge is a read-modify-write; the transaction in recordFailure must
    // serialize concurrent merges so none clobber another's contribution. A
    // lossy RMW here would drop selectors/error counts below N.
    test("merges tool-call-info losslessly across CONCURRENT tool_failure occurrences", async () => {
      const N = 10;
      await Promise.all(
        Array.from({ length: N }, (_unused, i) => repo.recordFailure(toolFailureInput(i))),
      );

      const groups = await db.selectFrom("failure_groups").selectAll().execute();
      expect(groups).toHaveLength(1);
      expect(groups[0].total_count).toBe(N);

      const toolInfo = JSON.parse(groups[0].tool_call_info_json ?? "{}");
      expect(toolInfo.toolName).toBe("tapOn");
      // Lossless: every occurrence's ELEMENT_NOT_FOUND and distinct selector survived.
      expect(toolInfo.errorCodes.ELEMENT_NOT_FOUND).toBe(N);
      expect(new Set(toolInfo.parameterVariants.selector).size).toBe(N);
    });
  });
});

async function createInstrumentedTestDatabase(): Promise<{
  db: Kysely<Database>;
  queryCount: () => number;
  resetQueryCount: () => void;
}> {
  const bunDb = new BunDatabase(":memory:");
  let count = 0;
  const db = new KyselyRuntime<Database>({
    dialect: new BunSqliteDialect({
      database: bunDb,
      beforeQuery: async () => {
        count++;
      },
    }),
  });
  await runMigrations(db as Kysely<unknown>);
  return {
    db,
    queryCount: () => count,
    resetQueryCount: () => {
      count = 0;
    },
  };
}

async function seedFailureGroup(
  db: Kysely<Database>,
  input: {
    id: string;
    signature: string;
    title: string;
    lastOccurrence: number;
    totalCount: number;
  },
): Promise<void> {
  await db
    .insertInto("failure_groups")
    .values({
      id: input.id,
      type: "crash",
      signature: input.signature,
      title: input.title,
      message: input.title,
      severity: "high",
      first_occurrence: input.lastOccurrence,
      last_occurrence: input.lastOccurrence,
      total_count: input.totalCount,
      unique_sessions: input.totalCount,
      stack_trace_json: null,
      tool_call_info_json: null,
      updated_at: new Date(input.lastOccurrence).toISOString(),
    })
    .execute();
}

async function seedFailureOccurrence(
  db: Kysely<Database>,
  input: {
    id: string;
    groupId: string;
    timestamp: number;
    deviceModel: string;
    appVersion: string;
    screenAtFailure: string;
    screensVisited: string[];
    capturePath: string;
  },
): Promise<void> {
  await db
    .insertInto("failure_occurrences")
    .values({
      id: input.id,
      group_id: input.groupId,
      timestamp: input.timestamp,
      device_id: null,
      device_model: input.deviceModel,
      os: "Android 14",
      app_version: input.appVersion,
      session_id: `session-${input.id}`,
      screen_at_failure: input.screenAtFailure,
      test_name: `test-${input.groupId}`,
      test_execution_id: null,
      error_code: null,
      duration_ms: null,
      tool_args_json: null,
    })
    .execute();

  await db
    .insertInto("failure_occurrence_screens")
    .values(
      input.screensVisited.map((screenName, index) => ({
        occurrence_id: input.id,
        screen_name: screenName,
        visit_order: index,
      })),
    )
    .execute();

  await db
    .insertInto("failure_captures")
    .values({
      id: `capture-${input.id}`,
      occurrence_id: input.id,
      type: "screenshot",
      path: input.capturePath,
      timestamp: input.timestamp,
      device_model: input.deviceModel,
    })
    .execute();
}

describe("FailureAnalyticsRepository row-cap retention (#3436)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: FailureAnalyticsRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1000);
    repo = new FailureAnalyticsRepository(timer, db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  function input(signature: string): RecordFailureInput {
    return {
      type: "crash",
      signature,
      title: `title ${signature}`,
      message: "m",
      severity: "critical",
      occurrence: { deviceModel: "Pixel 7", os: "Android 14", appVersion: "1.0.0", sessionId: "s" },
    };
  }

  test("pruneToRowCap trims to the cap and sweeps groups left with no occurrences", async () => {
    // Group "old" gets the two earliest occurrences; group "new" the two latest.
    timer.setCurrentTime(1000);
    await repo.recordFailure(input("old"));
    timer.setCurrentTime(2000);
    await repo.recordFailure(input("old"));
    timer.setCurrentTime(3000);
    await repo.recordFailure(input("new"));
    timer.setCurrentTime(4000);
    await repo.recordFailure(input("new"));

    expect(await db.selectFrom("failure_occurrences").selectAll().execute()).toHaveLength(4);
    expect(await db.selectFrom("failure_groups").selectAll().execute()).toHaveLength(2);

    // Keep only the 2 newest occurrences -> both belong to "new".
    await (repo as any).pruneToRowCap(2);

    const occurrences = await db
      .selectFrom("failure_occurrences")
      .select("timestamp")
      .orderBy("timestamp", "asc")
      .execute();
    expect(occurrences.map((o) => Number(o.timestamp))).toEqual([3000, 4000]);

    // "old" is now orphaned and swept; "new" still has occurrences and survives.
    const groups = await db.selectFrom("failure_groups").select("signature").execute();
    expect(groups.map((g) => g.signature)).toEqual(["new"]);
  });

  test("a group that keeps at least one occurrence is NOT swept", async () => {
    timer.setCurrentTime(1000);
    await repo.recordFailure(input("keep"));
    timer.setCurrentTime(2000);
    await repo.recordFailure(input("keep"));
    timer.setCurrentTime(3000);
    await repo.recordFailure(input("keep"));

    // Cap of 2 prunes the single oldest occurrence but the group retains two.
    await (repo as any).pruneToRowCap(2);

    expect(await db.selectFrom("failure_occurrences").selectAll().execute()).toHaveLength(2);
    const groups = await db.selectFrom("failure_groups").select("signature").execute();
    expect(groups.map((g) => g.signature)).toEqual(["keep"]);
  });

  test("under the cap, pruneToRowCap deletes nothing and sweeps no groups", async () => {
    timer.setCurrentTime(1000);
    await repo.recordFailure(input("a"));
    timer.setCurrentTime(2000);
    await repo.recordFailure(input("b"));

    await (repo as any).pruneToRowCap(10);

    expect(await db.selectFrom("failure_occurrences").selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom("failure_groups").selectAll().execute()).toHaveLength(2);
  });
});

describe("FailureAnalyticsRepository.getTimelineData (#3439)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: FailureAnalyticsRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    repo = new FailureAnalyticsRepository(timer, db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // Records one occurrence of `type` at `ts`. Distinct signatures per type keep
  // each type in its own group; the occurrence timestamp is the timer's value.
  async function record(
    type: "crash" | "anr" | "tool_failure" | "nonfatal",
    ts: number,
  ): Promise<void> {
    timer.setCurrentTime(ts);
    await repo.recordFailure({
      type,
      signature: `sig-${type}`,
      title: `title ${type}`,
      message: "m",
      severity: "critical",
      occurrence: { deviceModel: "Pixel 7", os: "Android 14", appVersion: "1.0.0", sessionId: "s" },
    });
  }

  const MINUTE = 60_000;

  test("buckets counts per type by minute and zero-fills empty buckets", async () => {
    await record("crash", 30_000); // bucket 0
    await record("nonfatal", 45_000); // bucket 0
    await record("crash", 90_000); // bucket 60_000
    await record("anr", 95_000); // bucket 60_000
    await record("tool_failure", 150_000); // bucket 120_000
    // bucket 180_000 stays empty

    const { dataPoints } = await repo.getTimelineData({
      startTime: 0,
      endTime: 180_000,
      aggregation: "minute",
    });

    // Buckets: 0, 60_000, 120_000, 180_000 (inclusive of the end bucket).
    expect(dataPoints).toHaveLength(4);
    expect(dataPoints[0]).toMatchObject({ crashes: 1, anrs: 0, toolFailures: 0, nonfatals: 1 });
    expect(dataPoints[1]).toMatchObject({ crashes: 1, anrs: 1, toolFailures: 0, nonfatals: 0 });
    expect(dataPoints[2]).toMatchObject({ crashes: 0, anrs: 0, toolFailures: 1, nonfatals: 0 });
    expect(dataPoints[3]).toMatchObject({ crashes: 0, anrs: 0, toolFailures: 0, nonfatals: 0 });
  });

  test("an occurrence on a bucket boundary lands in that bucket", async () => {
    await record("crash", MINUTE); // exactly bucket 60_000, not bucket 0

    const { dataPoints } = await repo.getTimelineData({
      startTime: 0,
      endTime: 2 * MINUTE,
      aggregation: "minute",
    });

    expect(dataPoints).toHaveLength(3);
    expect(dataPoints[0].crashes).toBe(0);
    expect(dataPoints[1].crashes).toBe(1);
    expect(dataPoints[2].crashes).toBe(0);
  });

  test("previousPeriodTotals counts the prior equal-length window by type", async () => {
    // Current window [180_000, 360_000); previous window [0, 180_000).
    await record("crash", 10_000);
    await record("crash", 20_000);
    await record("anr", 30_000);
    await record("tool_failure", 40_000);
    await record("nonfatal", 50_000);
    // Exactly at startTime belongs to the CURRENT window (previousEnd is exclusive).
    await record("crash", 180_000);

    const { previousPeriodTotals } = await repo.getTimelineData({
      startTime: 180_000,
      endTime: 360_000,
      aggregation: "minute",
    });

    expect(previousPeriodTotals).toEqual({ crashes: 2, anrs: 1, toolFailures: 1, nonfatals: 1 });
  });

  test("returns zeroed totals and buckets when the range is empty", async () => {
    const { dataPoints, previousPeriodTotals } = await repo.getTimelineData({
      startTime: 0,
      endTime: 2 * MINUTE,
      aggregation: "minute",
    });

    expect(previousPeriodTotals).toEqual({ crashes: 0, anrs: 0, toolFailures: 0, nonfatals: 0 });
    expect(dataPoints).toHaveLength(3);
    for (const dp of dataPoints) {
      expect(dp).toMatchObject({ crashes: 0, anrs: 0, toolFailures: 0, nonfatals: 0 });
    }
  });
});
