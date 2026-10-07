import { describe, expect, test } from "bun:test";
import { telemetryEventIdentityKey } from "../../src/daemon/telemetryPushSocketServer";
import { timelineBucketStart } from "../../src/db/failureTimelineBuckets";
import type { TelemetryEvent } from "../../src/features/telemetry/TelemetryRecorder";

// Interaction of #10118 (telemetry dedupe identity) and #10119/#10120 (UTC failures
// timeline buckets). Both read event timestamps; neither may change what the other
// stores or decides. The identity key is a pure function of the event, and a bucket
// is a pure function of a timestamp, so these pin that the two never feed each other.

// 2026-10-05 23:59:59.999 UTC and the next millisecond: adjacent UTC day buckets.
const LAST_MS_OF_DAY = Date.UTC(2026, 9, 5, 23, 59, 59, 999);
const FIRST_MS_OF_NEXT_DAY = LAST_MS_OF_DAY + 1;

function crash(timestamp: number): TelemetryEvent {
  return {
    category: "crash",
    timestamp,
    deviceId: "emulator-5554",
    sessionId: "session-1",
    data: { occurrenceId: "occ-1", timestamp },
  };
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object") {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

describe("telemetry dedupe identity vs failures timeline buckets (#10118 + #10119)", () => {
  test("a failure's identity ignores its timestamp, so the UTC bucket it lands in cannot change it", () => {
    const live = crash(LAST_MS_OF_DAY);
    // The backfilled copy of the same occurrence, read back with a timestamp that
    // falls in the NEXT UTC day bucket (e.g. a re-stamped row).
    const backfilled = crash(FIRST_MS_OF_NEXT_DAY);

    expect(timelineBucketStart(live.timestamp, "day")).not.toBe(
      timelineBucketStart(backfilled.timestamp, "day"),
    );
    expect(telemetryEventIdentityKey(live)).toBe(telemetryEventIdentityKey(backfilled));
    expect(telemetryEventIdentityKey(live)).not.toBeNull();
  });

  test("computing the identity neither mutates the event nor the timestamp the timeline buckets", () => {
    const event = deepFreeze(crash(LAST_MS_OF_DAY));
    const before = JSON.stringify(event);
    const bucketBefore = timelineBucketStart(event.timestamp, "week");

    // A frozen event throws on any write in strict mode, so a mutating key would fail here.
    expect(() => telemetryEventIdentityKey(event)).not.toThrow();

    expect(JSON.stringify(event)).toBe(before);
    expect(timelineBucketStart(event.timestamp, "week")).toBe(bucketBefore);
  });

  test("two distinct occurrences in one UTC bucket keep distinct identities (neither is deduped away)", () => {
    const first = crash(LAST_MS_OF_DAY - 5);
    const second: TelemetryEvent = {
      ...first,
      data: { occurrenceId: "occ-2", timestamp: LAST_MS_OF_DAY - 4 },
    };

    expect(timelineBucketStart(first.timestamp, "day")).toBe(
      timelineBucketStart(second.timestamp, "day"),
    );
    expect(telemetryEventIdentityKey(first)).not.toBe(telemetryEventIdentityKey(second));
  });

  test("network identity uses the raw millisecond timestamp, not a bucket", () => {
    const network = (timestamp: number): TelemetryEvent => ({
      category: "network",
      timestamp,
      deviceId: "emulator-5554",
      sessionId: "session-1",
      data: { applicationId: "com.example", sequenceNumber: 7, timestamp },
    });
    // Same sequence number a millisecond apart, inside one hour bucket: still two
    // events, because the identity must not be coarsened to the timeline's bucket.
    const a = network(Date.UTC(2026, 9, 5, 10, 0, 0, 1));
    const b = network(Date.UTC(2026, 9, 5, 10, 0, 0, 2));

    expect(timelineBucketStart(a.timestamp, "hour")).toBe(timelineBucketStart(b.timestamp, "hour"));
    expect(telemetryEventIdentityKey(a)).not.toBe(telemetryEventIdentityKey(b));
  });
});
