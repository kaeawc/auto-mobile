import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodePrototypeEvent } from "../../../src/features/observe/android/CtrlProxyPrototypes";
import type { PrototypeLocationFix } from "../../../src/features/prototype/prototypeLocationOutcome";
import {
  prototypeLocationEventSummary,
  redactPrototypeLocationEvent,
  redactPrototypeLocationEventData,
} from "../../../src/features/prototype/prototypeLocationPrivacy";
import { PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME } from "../../../src/features/prototype/prototypePlatform";
import { prototypePlatformDeliveredEventOf } from "../../../src/features/prototype/prototypePlatformEvent";

interface SummaryFixture {
  cases: { name: string; fix: PrototypeLocationFix; expected: Record<string, unknown> }[];
}

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, "../../fixtures/prototype-location/event-summary.json"),
    "utf8",
  ),
) as SummaryFixture;

const SENSITIVE = ["latitude", "longitude", "altitudeM", "speedMps", "bearingDeg"];

const fullFix = {
  latitude: 37.7749,
  longitude: -122.4194,
  accuracyM: 12,
  altitudeM: 16,
  speedMps: 3,
  bearingDeg: 90,
  timestampMs: 1_700_000_000_000,
  approximate: false,
};

const frame = (payload: unknown, name = PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME) => ({
  type: "prototype_event",
  timestamp: 1,
  id: "p",
  sequence: 1,
  kind: "emit",
  name,
  payload,
  state: {},
  pages: {},
});

describe("prototypeLocationEventSummary shared cases", () => {
  test("the fixture has cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });
  for (const entry of fixture.cases) {
    test(entry.name, () => {
      const summary = prototypeLocationEventSummary(entry.fix);
      expect<unknown>(summary).toEqual(entry.expected);
      expect(Object.keys(summary).filter((key) => SENSITIVE.includes(key))).toEqual([]);
    });
  }
});

describe("redactPrototypeLocationEventData", () => {
  test("keeps only a finite accuracy and a boolean approximate", () => {
    expect(redactPrototypeLocationEventData(fullFix)).toEqual({
      accuracyM: 12,
      approximate: false,
    });
    expect(redactPrototypeLocationEventData({ accuracyM: "12", approximate: "no" })).toEqual({});
    expect(redactPrototypeLocationEventData({ lat: 1, lon: 2, extra: { latitude: 1 } })).toEqual(
      {},
    );
  });

  test("a non-object reduces to an empty summary", () => {
    expect(redactPrototypeLocationEventData("37.7749,-122.4194")).toEqual({});
    expect(redactPrototypeLocationEventData([37.7749, -122.4194])).toEqual({});
    expect(redactPrototypeLocationEventData(null)).toEqual({});
  });
});

describe("decoded location.updated events", () => {
  test("carry no latitude, longitude, altitude, speed or bearing", () => {
    const decoded = decodePrototypeEvent(
      frame({ event: "location.updated", data: fullFix }),
      "test",
    );
    const delivered = prototypePlatformDeliveredEventOf(decoded!);
    expect<unknown>(delivered).toEqual({
      event: "location.updated",
      data: { accuracyM: 12, approximate: false },
    });
    expect(JSON.stringify(decoded)).not.toContain("37.7749");
    expect(Object.keys(delivered!.data as object).filter((k) => SENSITIVE.includes(k))).toEqual([]);
  });

  test("keep the simulated and truncated flags", () => {
    const decoded = decodePrototypeEvent(
      frame({ event: "location.updated", data: fullFix, simulated: true, truncated: true }),
      "test",
    );
    expect<unknown>(prototypePlatformDeliveredEventOf(decoded!)).toEqual({
      event: "location.updated",
      data: { accuracyM: 12, approximate: false },
      simulated: true,
      truncated: true,
    });
  });

  test("other platform events and other emits are unchanged", () => {
    const other = frame({ event: "battery.changed", data: { latitude: 1 } });
    expect<unknown>(decodePrototypeEvent(other, "test")?.payload).toEqual(other.payload);
    const plain = { kind: "emit" as const, name: "location.updated", payload: { latitude: 1 } };
    expect(redactPrototypeLocationEvent(plain)).toBe(plain);
  });
});
