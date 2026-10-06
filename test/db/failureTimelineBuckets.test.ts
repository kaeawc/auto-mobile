import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  formatTimelineBucketLabel,
  timelineBucketMs,
  timelineBucketStart,
  timelineBucketStartFromIndex,
  timelineBucketShiftMs,
} from "../../src/db/failureTimelineBuckets";

const DAY = 24 * 60 * 60 * 1000;

// 2026-10-05 is a Monday.
const MONDAY_OCT_5 = Date.UTC(2026, 9, 5);

describe("failureTimelineBuckets (#10120)", () => {
  const originalTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Labels must not depend on the host timezone; the zones below straddle UTC and
  // include DST-observing and half-hour-offset ones.
  // Restore by assigning the zone resolved at load; never `delete process.env.TZ`,
  // after which Bun stops honouring later TZ assignments.
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  describe("week buckets start on Monday 00:00 UTC", () => {
    test("the labelled Monday is the bucket start", () => {
      expect(timelineBucketStart(MONDAY_OCT_5, "week")).toBe(MONDAY_OCT_5);
      expect(formatTimelineBucketLabel(MONDAY_OCT_5, "week")).toBe("Oct 5");
    });

    test("Monday through Sunday share a bucket; the next Monday starts a new one", () => {
      for (let day = 0; day < 7; day++) {
        expect(timelineBucketStart(MONDAY_OCT_5 + day * DAY + 17 * 3_600_000, "week")).toBe(
          MONDAY_OCT_5,
        );
      }
      expect(timelineBucketStart(MONDAY_OCT_5 + 7 * DAY, "week")).toBe(MONDAY_OCT_5 + 7 * DAY);
    });

    test("the week edge is exact to the millisecond", () => {
      expect(timelineBucketStart(MONDAY_OCT_5 - 1, "week")).toBe(MONDAY_OCT_5 - 7 * DAY);
      expect(timelineBucketStart(MONDAY_OCT_5, "week")).toBe(MONDAY_OCT_5);
    });

    test("a week spanning a month edge is labelled with the Monday in the earlier month", () => {
      // Mon Sep 28 .. Sun Oct 4 2026 crosses the Sep/Oct boundary.
      const mondaySep28 = Date.UTC(2026, 8, 28);
      expect(timelineBucketStart(Date.UTC(2026, 9, 1, 0, 0, 0), "week")).toBe(mondaySep28);
      expect(formatTimelineBucketLabel(mondaySep28, "week")).toBe("Sep 28");
    });

    test("every week bucket start formats as a Monday near the epoch and far from it", () => {
      for (const ts of [0, 3 * DAY, 4 * DAY - 1, 4 * DAY, Date.UTC(2038, 0, 19), MONDAY_OCT_5]) {
        const start = timelineBucketStart(ts, "week");
        expect(new Date(start).getUTCDay()).toBe(1);
        expect(start).toBeLessThanOrEqual(ts);
        expect(ts - start).toBeLessThan(7 * DAY);
      }
    });

    test("an SQL bucket index maps back to the same bucket start", () => {
      const ts = MONDAY_OCT_5 + 3 * DAY + 123;
      const index = Math.trunc((ts + timelineBucketShiftMs("week")) / timelineBucketMs("week"));
      expect(timelineBucketStartFromIndex(index, "week")).toBe(MONDAY_OCT_5);
    });
  });

  describe("day, hour and minute buckets are UTC-aligned", () => {
    test("day buckets start at 00:00 UTC and are labelled with that UTC date", () => {
      const start = timelineBucketStart(Date.UTC(2026, 9, 5, 17, 0), "day");
      expect(start).toBe(MONDAY_OCT_5);
      expect(formatTimelineBucketLabel(start, "day")).toBe("Oct 5");
    });

    test("a month edge labels the first of the month", () => {
      expect(formatTimelineBucketLabel(Date.UTC(2026, 8, 30), "day")).toBe("Sep 30");
      expect(formatTimelineBucketLabel(Date.UTC(2026, 9, 1), "day")).toBe("Oct 1");
    });

    test("hour and minute labels use the 12-hour UTC clock", () => {
      expect(formatTimelineBucketLabel(Date.UTC(2026, 9, 5, 0, 0), "hour")).toBe("12 AM");
      expect(formatTimelineBucketLabel(Date.UTC(2026, 9, 5, 12, 0), "hour")).toBe("12 PM");
      expect(formatTimelineBucketLabel(Date.UTC(2026, 9, 5, 17, 0), "hour")).toBe("5 PM");
      expect(formatTimelineBucketLabel(Date.UTC(2026, 9, 5, 17, 5), "minute")).toBe("5:05 PM");
    });
  });

  describe("labels do not depend on the host timezone", () => {
    beforeEach(() => {
      // Sanity: the platform honours a runtime TZ change, so the cases below
      // really run under each zone.
      process.env.TZ = "America/Los_Angeles";
      // Bun on Windows does not re-read a runtime TZ assignment, so the zone stays at
      // the host's and the sanity check cannot hold there; the labels are computed
      // from UTC fields, so the cases below stay valid on every platform.
      if (process.platform !== "win32") {
        expect(new Date(MONDAY_OCT_5).getHours()).toBe(17);
      }
    });

    test.each(["America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata", "UTC"])(
      "%s: day, week, hour and minute labels name the UTC bucket start",
      (zone) => {
        process.env.TZ = zone;
        expect(formatTimelineBucketLabel(MONDAY_OCT_5, "day")).toBe("Oct 5");
        expect(formatTimelineBucketLabel(MONDAY_OCT_5, "week")).toBe("Oct 5");
        expect(formatTimelineBucketLabel(MONDAY_OCT_5 + 17 * 3_600_000, "hour")).toBe("5 PM");
        expect(
          formatTimelineBucketLabel(MONDAY_OCT_5 + 17 * 3_600_000 + 5 * 60_000, "minute"),
        ).toBe("5:05 PM");
      },
    );

    test("across the US spring-forward change consecutive hour and day buckets keep consecutive labels", () => {
      process.env.TZ = "America/Los_Angeles";
      // 2026-03-08 10:00 UTC is the instant local clocks jump 02:00 -> 03:00.
      const springForward = Date.UTC(2026, 2, 8, 10, 0);
      const hourLabels = [-2, -1, 0, 1, 2].map((offset) =>
        formatTimelineBucketLabel(springForward + offset * 3_600_000, "hour"),
      );
      expect(hourLabels).toEqual(["8 AM", "9 AM", "10 AM", "11 AM", "12 PM"]);

      const dayLabels = [-1, 0, 1].map((offset) =>
        formatTimelineBucketLabel(Date.UTC(2026, 2, 8) + offset * DAY, "day"),
      );
      expect(dayLabels).toEqual(["Mar 7", "Mar 8", "Mar 9"]);

      // The week containing the change starts on Monday Mar 2.
      expect(formatTimelineBucketLabel(timelineBucketStart(springForward, "week"), "week")).toBe(
        "Mar 2",
      );
    });

    test("across the US fall-back change no label repeats or skips", () => {
      process.env.TZ = "America/Los_Angeles";
      // 2026-11-01 09:00 UTC is the instant local clocks fall back 02:00 -> 01:00.
      const fallBack = Date.UTC(2026, 10, 1, 9, 0);
      const hourLabels = [-2, -1, 0, 1, 2].map((offset) =>
        formatTimelineBucketLabel(fallBack + offset * 3_600_000, "hour"),
      );
      expect(hourLabels).toEqual(["7 AM", "8 AM", "9 AM", "10 AM", "11 AM"]);
    });
  });
});
