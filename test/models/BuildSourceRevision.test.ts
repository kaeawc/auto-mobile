import { describe, expect, test } from "bun:test";
import {
  parseBuildSourceRevision,
  sameBuildSourceRevision,
} from "../../src/models/BuildSourceRevision";

describe("parseBuildSourceRevision (#16954)", () => {
  test("accepts a branch and hex sha, trimming and lower-casing the sha", () => {
    expect(parseBuildSourceRevision(" feature/login ", " ABCDEF1234567 ")).toEqual({
      gitBranch: "feature/login",
      gitSha: "abcdef1234567",
    });
  });

  test("requires both keys", () => {
    expect(parseBuildSourceRevision(undefined, "abcdef1")).toBeUndefined();
    expect(parseBuildSourceRevision("main", undefined)).toBeUndefined();
    expect(parseBuildSourceRevision(null, null)).toBeUndefined();
  });

  test("rejects blank, oversized or control-character branches", () => {
    expect(parseBuildSourceRevision("  ", "abcdef1")).toBeUndefined();
    expect(parseBuildSourceRevision("b".repeat(256), "abcdef1")).toBeUndefined();
    expect(parseBuildSourceRevision("ma\nin", "abcdef1")).toBeUndefined();
  });

  test("rejects shas that are not 7-64 hex characters", () => {
    expect(parseBuildSourceRevision("main", "abc")).toBeUndefined();
    expect(parseBuildSourceRevision("main", "xyz1234")).toBeUndefined();
    expect(parseBuildSourceRevision("main", "a".repeat(65))).toBeUndefined();
    expect(parseBuildSourceRevision("main", 1234567)).toBeUndefined();
  });

  test("compares optional revisions by value", () => {
    const a = { gitBranch: "main", gitSha: "abcdef1" };
    expect(sameBuildSourceRevision(undefined, undefined)).toBe(true);
    expect(sameBuildSourceRevision(a, { ...a })).toBe(true);
    expect(sameBuildSourceRevision(a, undefined)).toBe(false);
    expect(sameBuildSourceRevision(a, { ...a, gitSha: "abcdef2" })).toBe(false);
  });
});
