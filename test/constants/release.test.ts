import { describe, expect, test } from "bun:test";
import { usesMutableLatestRelease } from "../../src/constants/release";

describe("release constants helpers", function() {
  test("treats latest release references as mutable", function() {
    expect(usesMutableLatestRelease("latest")).toBe(true);
    expect(usesMutableLatestRelease("LATEST")).toBe(true);
    expect(usesMutableLatestRelease(" latest ")).toBe(true);
  });

  test("does not treat pinned release references as mutable", function() {
    expect(usesMutableLatestRelease("0.0.15")).toBe(false);
    expect(usesMutableLatestRelease("v0.0.15")).toBe(false);
    expect(usesMutableLatestRelease("")).toBe(false);
  });
});
