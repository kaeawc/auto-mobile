import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  formatTimelineBucketLabel,
  timelineBucketMs,
  timelineBucketStart,
  timelineBucketStartFromIndex,
  timelineBucketShiftMs,
} from "../../src/db/failureTimelineBuckets";

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 2026-10-05 is a Monday.
const MONDAY_OCT_5 = Date.UTC(2026, 9, 5);

describe("failureTimelineBuckets (#10120)", () => {
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

  // The labels are claimed to depend only on the instant, never on the host zone. The
  // process zone is never mutated here (a runtime TZ change is process-global and
  // engine-cached, so it leaks between files and is not honoured on every platform).
  // Instead, host-independence is shown two ways that hold on every host:
  // 1. the label code never calls a local-time Date accessor, and
  // 2. labels over a sweep of instants match the UTC calendar, derived with arithmetic
  //    only, so any non-UTC host zone offset (whole, half or 45-minute) would shift them.
  describe("labels do not depend on the host timezone", () => {
    const localAccessors = [
      "getFullYear",
      "getMonth",
      "getDate",
      "getDay",
      "getHours",
      "getMinutes",
      "getSeconds",
      "getTimezoneOffset",
      "toLocaleString",
      "toLocaleDateString",
      "toLocaleTimeString",
      "toString",
      "toDateString",
      "toTimeString",
    ] as const;
    let restores: Array<() => void> = [];

    function forbidLocalAccessors(): void {
      restores = localAccessors.map((name) => {
        const spy = spyOn(Date.prototype, name).mockImplementation(() => {
          throw new Error(`Date.prototype.${name} reads the host time zone`);
        });
        return () => spy.mockRestore();
      });
    }

    afterEach(() => {
      restores.forEach((restore) => restore());
      restores = [];
    });

    function expectedClock(utcHours: number, utcMinutes: number | null): string {
      const hour12 = utcHours % 12 || 12;
      const suffix = utcHours < 12 ? "AM" : "PM";
      return utcMinutes === null
        ? `${hour12} ${suffix}`
        : `${hour12}:${String(utcMinutes).padStart(2, "0")} ${suffix}`;
    }

    test("no aggregation reads a local-time Date accessor", () => {
      forbidLocalAccessors();
      const at = MONDAY_OCT_5 + 17 * 3_600_000 + 5 * 60_000;
      expect(formatTimelineBucketLabel(at, "day")).toBe("Oct 5");
      expect(formatTimelineBucketLabel(at, "week")).toBe("Oct 5");
      expect(formatTimelineBucketLabel(at, "hour")).toBe("5 PM");
      expect(formatTimelineBucketLabel(at, "minute")).toBe("5:05 PM");
    });

    test("every quarter hour of a UTC day is labelled with its UTC clock reading", () => {
      // Quarter-hour steps catch whole-hour, half-hour (Asia/Kolkata) and 45-minute
      // (Asia/Kathmandu) offsets; spanning the day edge catches date shifts either way.
      for (let step = 0; step < 96; step++) {
        const at = MONDAY_OCT_5 + step * 15 * 60_000;
        const utcHours = Math.floor(step / 4);
        const utcMinutes = (step % 4) * 15;
        expect(formatTimelineBucketLabel(at, "minute")).toBe(expectedClock(utcHours, utcMinutes));
        expect(formatTimelineBucketLabel(at, "hour")).toBe(expectedClock(utcHours, null));
        expect(formatTimelineBucketLabel(at, "day")).toBe("Oct 5");
      }
      expect(formatTimelineBucketLabel(MONDAY_OCT_5 - 1, "day")).toBe("Oct 4");
      expect(formatTimelineBucketLabel(MONDAY_OCT_5 + DAY, "day")).toBe("Oct 6");
    });

    test("hour and day labels stay consecutive across the dates of US and Southern DST changes", () => {
      // 2026-03-08 and 2026-11-01 are the US transitions; 2026-04-05 and 2026-10-04 are the
      // Australia/NZ ones. UTC has no transition, so 48 consecutive hours never repeat or
      // skip a label whatever zone the host is in.
      const transitionDays = [
        Date.UTC(2026, 2, 8),
        Date.UTC(2026, 3, 5),
        Date.UTC(2026, 9, 4),
        Date.UTC(2026, 10, 1),
      ];
      for (const dayStart of transitionDays) {
        for (let hour = 0; hour < 48; hour++) {
          const at = dayStart + hour * 3_600_000;
          expect(formatTimelineBucketLabel(at, "hour")).toBe(expectedClock(hour % 24, null));
          const date = new Date(dayStart + Math.floor(hour / 24) * DAY);
          expect(formatTimelineBucketLabel(at, "day")).toBe(
            `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`,
          );
        }
      }
    });

    test("the week containing a DST change is labelled by its UTC Monday", () => {
      // The US spring-forward week starts on Monday Mar 2 2026; the fall-back week on Oct 26.
      expect(
        formatTimelineBucketLabel(timelineBucketStart(Date.UTC(2026, 2, 8, 10, 0), "week"), "week"),
      ).toBe("Mar 2");
      expect(
        formatTimelineBucketLabel(timelineBucketStart(Date.UTC(2026, 10, 1, 9, 0), "week"), "week"),
      ).toBe("Oct 26");
    });
  });
});
