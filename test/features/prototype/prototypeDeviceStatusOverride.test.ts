import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  prototypeStatusChangeEvents,
  prototypeStatusDebounceMs,
  type PrototypeStatusModule,
  type PrototypeStatusUpdate,
} from "../../../src/features/prototype/prototypeDeviceStatusReference";
import {
  prototypeStatusOverrideUpdates,
  type PrototypeStatusInput,
} from "../../../src/features/prototype/prototypeDeviceStatusOverride";

const directory = path.join(import.meta.dir, "../../fixtures/prototype-device-status");
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(path.join(directory, name), "utf8")) as T;
const overrides = readdirSync(directory)
  .filter((name) => name.startsWith("override-") && name.endsWith(".json"))
  .sort();

interface Stream {
  module: PrototypeStatusModule;
  platform: "android" | "ios";
  inputs: PrototypeStatusInput[];
  expectedUpdates: PrototypeStatusUpdate[];
  expectedEvents: PrototypeStatusUpdate[];
}
interface Rejection {
  name: string;
  module: PrototypeStatusModule;
  platform: "android" | "ios";
  inputs: PrototypeStatusInput[];
  expectedError: { index: number; path: string };
}

describe("shared simulate override streams", () => {
  test("the fixture set covers seed and reset, seeding without a reading, no-ops and rejections", () => {
    expect(overrides).toEqual([
      "override-rejections.json",
      "override-seed-and-reset.json",
      "override-seed-unchanged.json",
      "override-seed-without-reading.json",
    ]);
  });
  for (const name of overrides.filter((file) => file !== "override-rejections.json")) {
    test(name, () => {
      const stream = fixture<Stream>(name);
      const result = prototypeStatusOverrideUpdates(stream.module, stream.platform, stream.inputs);
      expect(result).toEqual({ success: true, updates: stream.expectedUpdates });
      const updates = result.success ? result.updates : [];
      const debounceMs = prototypeStatusDebounceMs(stream.module);
      expect(prototypeStatusChangeEvents(updates, debounceMs)).toEqual(stream.expectedEvents);
    });
  }
  const { cases } = fixture<{ cases: Rejection[] }>("override-rejections.json");
  for (const rejection of cases) {
    test(`rejects ${rejection.name}`, () => {
      const result = prototypeStatusOverrideUpdates(
        rejection.module,
        rejection.platform,
        rejection.inputs,
      );
      expect(result.success).toBe(false);
      const located = result.success ? undefined : { index: result.index, path: result.path };
      expect(located).toEqual(rejection.expectedError);
    });
  }
});

describe("prototypeStatusOverrideUpdates", () => {
  test("real readings pass through unchanged without a mode switch", () => {
    const readings: PrototypeStatusInput[] = [
      { timestampMs: 0, reading: { saver: false } },
      { timestampMs: 10, reading: { saver: true } },
    ];
    expect(prototypeStatusOverrideUpdates("power", "android", readings)).toEqual({
      success: true,
      updates: [
        { timestampMs: 0, values: { saver: false } },
        { timestampMs: 10, values: { saver: true } },
      ],
    });
  });

  test("a refusal names the reason", () => {
    const result = prototypeStatusOverrideUpdates("audio", "ios", [
      { timestampMs: 0, mode: "fake" },
      { timestampMs: 1, seed: { ringer: "silent" } },
    ]);
    expect(result.success ? "" : result.error).toBe(
      "/platform/audio/ringer is not reported on ios",
    );
  });
});
