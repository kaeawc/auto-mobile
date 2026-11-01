import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  prototypeAndroidBatteryLevel,
  prototypeAndroidBatteryState,
  prototypeAndroidRingerMode,
  prototypeAndroidThermalState,
  prototypeAndroidVolume,
  prototypeIosBatteryLevel,
  prototypeIosBatteryState,
  prototypeIosThermalState,
  prototypeIosVolume,
  prototypeStatusChangeEvents,
  prototypeStatusDebounceMs,
  type PrototypeStatusModule,
  type PrototypeStatusUpdate,
} from "../../../src/features/prototype/prototypeDeviceStatusReference";

const directory = path.join(import.meta.dir, "../../fixtures/prototype-device-status");
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(directory, name), "utf8"));
const names = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();

type Row = [number, unknown] | [number, number, unknown];
/** Fixture `null` is a key the runtime leaves absent. */
const absent = (value: unknown) => (value === null ? undefined : value);
const rows = (name: string, table: string) => fixture(name)[table] as Row[];

describe("shared device status mappings", () => {
  const unary: [string, string, (value: number) => unknown][] = [
    ["mapping-thermal.json", "android", prototypeAndroidThermalState],
    ["mapping-thermal.json", "ios", prototypeIosThermalState],
    ["mapping-battery.json", "androidState", prototypeAndroidBatteryState],
    ["mapping-battery.json", "iosState", prototypeIosBatteryState],
    ["mapping-battery.json", "iosLevel", prototypeIosBatteryLevel],
    ["mapping-audio.json", "iosVolume", prototypeIosVolume],
    ["mapping-audio.json", "androidRinger", prototypeAndroidRingerMode],
  ];
  for (const [name, table, map] of unary) {
    test(`${name} ${table}`, () => {
      for (const [input, expected] of rows(name, table) as [number, unknown][]) {
        expect([input, map(input)]).toEqual([input, absent(expected)]);
      }
    });
  }
  const binary: [string, string, (value: number, of: number) => unknown][] = [
    ["mapping-battery.json", "androidLevel", prototypeAndroidBatteryLevel],
    ["mapping-audio.json", "androidVolume", prototypeAndroidVolume],
  ];
  for (const [name, table, map] of binary) {
    test(`${name} ${table}`, () => {
      for (const [value, of, expected] of rows(name, table) as [number, number, unknown][]) {
        expect([value, of, map(value, of)]).toEqual([value, of, absent(expected)]);
      }
    });
  }
  test("every mapping table is replayed", () => {
    const replayed = new Set([...unary, ...binary].map(([name, table]) => `${name}#${table}`));
    const tables = names
      .filter((name) => name.startsWith("mapping-"))
      .flatMap((name) =>
        Object.keys(fixture(name))
          .filter((key) => key !== "description")
          .map((table) => `${name}#${table}`),
      );
    expect(tables.sort()).toEqual([...replayed].sort());
  });
});

describe("shared change-event streams", () => {
  const streams = names.filter((name) => name.startsWith("debounce-"));
  test("the fixture set covers bursts, spacing, reverts and a timer due at a reading", () => {
    expect(streams).toEqual([
      "debounce-burst.json",
      "debounce-due-at-reading.json",
      "debounce-revert.json",
      "debounce-spaced.json",
    ]);
  });
  for (const name of streams) {
    test(name, () => {
      const { module, updates, expectedEvents } = fixture(name) as {
        module: PrototypeStatusModule;
        updates: PrototypeStatusUpdate[];
        expectedEvents: PrototypeStatusUpdate[];
      };
      expect(prototypeStatusChangeEvents(updates, prototypeStatusDebounceMs(module))).toEqual(
        expectedEvents,
      );
    });
  }
});

describe("prototypeStatusChangeEvents", () => {
  test("a single reading and an empty stream deliver nothing", () => {
    expect(prototypeStatusChangeEvents([], 500)).toEqual([]);
    expect(prototypeStatusChangeEvents([{ timestampMs: 0, values: { saver: true } }], 500)).toEqual(
      [],
    );
  });

  test("a key that appears or disappears is a change", () => {
    const events = prototypeStatusChangeEvents(
      [
        { timestampMs: 0, values: { state: "unknown" } },
        { timestampMs: 10, values: { state: "unknown", level: 5 } },
        { timestampMs: 1000, values: { state: "unknown" } },
      ],
      500,
    );
    expect(events.map((event) => event.timestampMs)).toEqual([510, 1500]);
  });
});

test("every status module's changed event is debounced 500 ms by the contract", () => {
  expect((["battery", "power", "audio"] as const).map(prototypeStatusDebounceMs)).toEqual([
    500, 500, 500,
  ]);
});
