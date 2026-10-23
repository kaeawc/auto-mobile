import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  mutationIncarnation,
  type MutationIncarnationKey,
} from "../../../src/daemon/sessionBroker/mutations/incarnation";

const android = {
  platform: "android",
  resourceId: "resource",
  stableDeviceId: "avd",
  bootId: "boot",
} as const;
const ios = {
  platform: "ios",
  scopeKey: "pool",
  allocationIndex: 0,
  stableDeviceId: "udid",
} as const;
describe("mutation incarnation", () => {
  test("Android uses native and boot identity, with resource at element zero for pruning", () => {
    expect(mutationIncarnation(android)).toBe('["resource","avd","boot"]');
    expect(JSON.parse(mutationIncarnation(android))[0]).toBe("resource");
    expect(mutationIncarnation({ ...android, bootId: null })).toBe('["resource","avd",null]');
  });
  test("iOS is byte compatible with the existing tuple", () => {
    expect(mutationIncarnation(ios)).toBe(
      JSON.stringify([ios.scopeKey, ios.allocationIndex, ios.stableDeviceId]),
    );
  });
  const invalid: MutationIncarnationKey[] = [
    { ...android, resourceId: "" },
    { ...android, stableDeviceId: " " },
    { ...android, bootId: " " },
    { ...ios, scopeKey: "\t" },
    { ...ios, stableDeviceId: "" },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((allocationIndex) => ({
      ...ios,
      allocationIndex,
    })),
  ];
  test.each(invalid)("rejects invalid identity %j", (key) => {
    expect(() => mutationIncarnation(key)).toThrow(ActionableError);
  });
});
