import { expect, test } from "bun:test";
import { resolveSessionDevicePlatform } from "../../../src/server/pipeline/resolveSessionDevicePlatform";
import type { Platform, SomePlatform } from "../../../src/models/Platform";

const simulatorId = "8935BFAD-F01F-40FF-95E0-83FD0FF63DEB";
const cases: [Platform | undefined, SomePlatform | undefined, string, Platform][] = [
  ["ios", "android", "emulator-5554", "ios"],
  ["android", "ios", simulatorId, "android"],
  [undefined, "ios", "emulator-5554", "ios"],
  [undefined, "android", simulatorId, "android"],
  [undefined, "either", simulatorId, "ios"],
  [undefined, undefined, simulatorId, "ios"],
  [undefined, "either", "00008030-001C2D3E1234567A", "ios"],
  [undefined, "either", "a".repeat(40), "ios"],
  [undefined, "either", "emulator-5554", "android"],
  [undefined, undefined, "R5CT123ABCD", "android"],
  // A watch is reached only when named; its UDID alone reads as an iOS simulator (#14908).
  [undefined, "watchos", simulatorId, "watchos"],
  ["watchos", undefined, simulatorId, "watchos"],
];
test.each(cases)("pool %s request %s id %s -> %s", (pooled, requested, deviceId, expected) => {
  expect(resolveSessionDevicePlatform(pooled, requested, deviceId)).toBe(expected);
});
