import { describe, expect, test } from "bun:test";
import { DeviceSnapshotRepository } from "../../src/db/deviceSnapshotRepository";
import { VideoRecordingRepository } from "../../src/db/videoRecordingRepository";
import { FakeDeviceSnapshotRepository } from "./FakeDeviceSnapshotRepository";
import { FakeVideoRecordingRepository } from "./FakeVideoRecordingRepository";

/**
 * Conformance ratchet for fakes that do NOT carry an `implements` clause (so the
 * compiler cannot catch interface drift). For each pair, every PUBLIC method the
 * real class exposes must also exist on the fake — otherwise a consumer that
 * casts the fake `as any` would silently miss a method the real object grows
 * (issue #4186). A pure method-name check, no `"get" + "Db"` string games: the
 * one private method (`getDb`) is excluded by name.
 */

// Methods present on the real prototype that are not part of the substitutable
// public surface a fake must mirror.
const NON_PUBLIC = new Set(["constructor", "getDb"]);

function publicMethodNames(realClass: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(realClass.prototype).filter(name => {
    if (NON_PUBLIC.has(name) || name.startsWith("_")) {
      return false;
    }
    return typeof (realClass.prototype as Record<string, unknown>)[name] === "function";
  });
}

const pairs: Array<{
  name: string;
  realClass: { prototype: object };
  fake: object;
}> = [
  {
    name: "DeviceSnapshotRepository",
    realClass: DeviceSnapshotRepository,
    fake: new FakeDeviceSnapshotRepository(),
  },
  {
    name: "VideoRecordingRepository",
    realClass: VideoRecordingRepository,
    fake: new FakeVideoRecordingRepository(),
  },
];

describe("fake/real conformance (#4186)", () => {
  for (const { name, realClass, fake } of pairs) {
    test(`the fake for ${name} exposes every public method of the real class`, () => {
      const expected = publicMethodNames(realClass);
      // Sanity: the introspection must actually find methods, else the guard is
      // vacuous.
      expect(expected.length).toBeGreaterThan(0);

      const missing = expected.filter(
        method => typeof (fake as Record<string, unknown>)[method] !== "function"
      );
      expect(missing).toEqual([]);
    });
  }
});
