import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { FailureAnalyticsRepository } from "../../src/db/failureAnalyticsRepository";
import { createTestDatabase } from "./testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// Unit (in-memory DB) coverage for the timeline's bucketing and labelling basis:
// buckets and labels are both UTC, weeks start Monday 00:00 UTC (#10120). The
// pre-existing `getTimelineData (#3439)` suite lives in the integration file and
// is mirrored here for the minute buckets so this fast file also guards the SQL
// shape.
describe("FailureAnalyticsRepository.getTimelineData bucket basis (#10120)", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const MINUTE = 60 * 1000;
  // 2026-10-05 is a Monday.
  const MONDAY_OCT_5 = Date.UTC(2026, 9, 5);
  const originalTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
    // Assign, never `delete`: Bun stops honouring TZ changes after a delete.
    process.env.TZ = originalTz;
  });

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

  test("a Monday and the following Thursday land in the same week bucket labelled with that Monday", async () => {
    await record("crash", MONDAY_OCT_5 + 10 * HOUR);
    await record("anr", MONDAY_OCT_5 + 3 * DAY + 10 * HOUR);

    const { dataPoints } = await repo.getTimelineData({
      startTime: MONDAY_OCT_5,
      endTime: MONDAY_OCT_5 + 6 * DAY,
      aggregation: "week",
    });

    expect(dataPoints).toEqual([
      { label: "Oct 5", crashes: 1, anrs: 1, toolFailures: 0, nonfatals: 0 },
    ]);
  });

  test("the week edge: Sunday 23:59:59.999 is last week, Monday 00:00:00.000 is this week", async () => {
    await record("crash", MONDAY_OCT_5 - 1);
    await record("anr", MONDAY_OCT_5);

    const { dataPoints } = await repo.getTimelineData({
      startTime: MONDAY_OCT_5 - 7 * DAY,
      endTime: MONDAY_OCT_5 + DAY,
      aggregation: "week",
    });

    expect(dataPoints).toEqual([
      { label: "Sep 28", crashes: 1, anrs: 0, toolFailures: 0, nonfatals: 0 },
      { label: "Oct 5", crashes: 0, anrs: 1, toolFailures: 0, nonfatals: 0 },
    ]);
  });

  test("a week spanning a month edge is one bucket labelled with its Monday", async () => {
    await record("crash", Date.UTC(2026, 8, 30, 23, 0)); // Wed Sep 30
    await record("crash", Date.UTC(2026, 9, 1, 1, 0)); // Thu Oct 1

    const { dataPoints } = await repo.getTimelineData({
      startTime: Date.UTC(2026, 8, 28),
      endTime: Date.UTC(2026, 9, 4, 23, 59),
      aggregation: "week",
    });

    expect(dataPoints).toEqual([
      { label: "Sep 28", crashes: 2, anrs: 0, toolFailures: 0, nonfatals: 0 },
    ]);
  });

  test("day buckets are UTC days labelled with the UTC date, whatever the host timezone", async () => {
    process.env.TZ = "America/Los_Angeles";
    // Monday 10:00 Pacific, i.e. 17:00 UTC: the day bucket is Oct 5, not Oct 4.
    await record("crash", Date.UTC(2026, 9, 5, 17, 0));

    const { dataPoints } = await repo.getTimelineData({
      startTime: MONDAY_OCT_5 - DAY,
      endTime: MONDAY_OCT_5 + DAY,
      aggregation: "day",
    });

    expect(dataPoints.map((point) => [point.label, point.crashes])).toEqual([
      ["Oct 4", 0],
      ["Oct 5", 1],
      ["Oct 6", 0],
    ]);
  });

  test("the issue's week scenario under a UTC-negative host: the crash is in this week's bar", async () => {
    process.env.TZ = "America/Los_Angeles";
    await record("crash", Date.UTC(2026, 9, 5, 17, 0));

    const { dataPoints } = await repo.getTimelineData({
      startTime: Date.UTC(2026, 9, 5, 17, 0) - 30 * DAY,
      endTime: Date.UTC(2026, 9, 5, 17, 0) + HOUR,
      aggregation: "week",
    });

    const withCrash = dataPoints.filter((point) => point.crashes > 0);
    expect(withCrash).toEqual([
      { label: "Oct 5", crashes: 1, anrs: 0, toolFailures: 0, nonfatals: 0 },
    ]);
    expect(dataPoints[dataPoints.length - 1].label).toBe("Oct 5");
  });

  test("across the US DST change, day and hour bucket labels do not shift", async () => {
    process.env.TZ = "America/Los_Angeles";
    const springForward = Date.UTC(2026, 2, 8, 10, 0); // 02:00 PST -> 03:00 PDT
    await record("crash", springForward);

    const days = await repo.getTimelineData({
      startTime: Date.UTC(2026, 2, 7),
      endTime: Date.UTC(2026, 2, 9),
      aggregation: "day",
    });
    expect(days.dataPoints.map((point) => [point.label, point.crashes])).toEqual([
      ["Mar 7", 0],
      ["Mar 8", 1],
      ["Mar 9", 0],
    ]);

    const hours = await repo.getTimelineData({
      startTime: springForward - HOUR,
      endTime: springForward + HOUR,
      aggregation: "hour",
    });
    expect(hours.dataPoints.map((point) => [point.label, point.crashes])).toEqual([
      ["9 AM", 0],
      ["10 AM", 1],
      ["11 AM", 0],
    ]);
  });

  test("a week containing early-epoch timestamps still buckets (non-negative SQL dividend)", async () => {
    await record("crash", 1000); // Thu 1970-01-01, belongs to the week of Mon 1969-12-29

    const { dataPoints } = await repo.getTimelineData({
      startTime: 0,
      endTime: 5 * DAY,
      aggregation: "week",
    });

    expect(dataPoints.map((point) => [point.label, point.crashes])).toEqual([
      ["Dec 29", 1],
      ["Jan 5", 0],
    ]);
  });

  test("minute buckets are unchanged: zero-filled, boundary-inclusive, per type", async () => {
    await record("crash", 30_000);
    await record("nonfatal", 45_000);
    await record("crash", MINUTE + 30_000);
    await record("tool_failure", 2 * MINUTE + 30_000);

    const { dataPoints } = await repo.getTimelineData({
      startTime: 0,
      endTime: 3 * MINUTE,
      aggregation: "minute",
    });

    expect(dataPoints).toHaveLength(4);
    expect(dataPoints[0]).toMatchObject({ crashes: 1, nonfatals: 1 });
    expect(dataPoints[1]).toMatchObject({ crashes: 1 });
    expect(dataPoints[2]).toMatchObject({ toolFailures: 1 });
    expect(dataPoints[3]).toMatchObject({ crashes: 0, anrs: 0, toolFailures: 0, nonfatals: 0 });
  });
});
