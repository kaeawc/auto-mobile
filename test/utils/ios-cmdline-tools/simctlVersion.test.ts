import { describe, expect, test } from "bun:test";
import {
  compareSimctlVersions,
  decodeSimctlVersion,
  parseSimctlVersion,
} from "../../../src/utils/ios-cmdline-tools/simctlVersion";

describe("simctl version helpers", () => {
  test("parses dotted and packed versions into the same tuple", () => {
    expect(decodeSimctlVersion(1114112)).toEqual(parseSimctlVersion("17.0"));
    expect(decodeSimctlVersion(1115137)).toEqual(parseSimctlVersion("17.4.1"));
  });

  test("represents the packed unbounded maximum above real versions", () => {
    const unbounded = decodeSimctlVersion(4294967295);
    const runtime = parseSimctlVersion("99.0");
    expect(unbounded).toEqual([Number.POSITIVE_INFINITY, 0, 0]);
    expect(runtime).toBeDefined();
    expect(compareSimctlVersions(runtime!, unbounded!)).toBeLessThan(0);
  });
});
