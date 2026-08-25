import { describe, it, expect } from "bun:test";
import { assertSafeSnapshotName } from "../../src/utils/snapshotNameValidation";
import { ActionableError } from "../../src/models";

describe("assertSafeSnapshotName (#5705)", () => {
  it("refuses a parent-directory traversal name '../x'", () => {
    expect(() => assertSafeSnapshotName("../traversal_x")).toThrow(ActionableError);
    expect(() => assertSafeSnapshotName("../x")).toThrow(/path separator/i);
  });

  it("refuses a nested path 'a/b'", () => {
    expect(() => assertSafeSnapshotName("a/b")).toThrow(ActionableError);
    expect(() => assertSafeSnapshotName("a/b")).toThrow(/path separator/i);
  });

  it("refuses an absolute POSIX path", () => {
    expect(() => assertSafeSnapshotName("/etc/passwd")).toThrow(ActionableError);
  });

  it("refuses a Windows-style separator and drive-letter absolute path", () => {
    expect(() => assertSafeSnapshotName("a\\b")).toThrow(/path separator/i);
    expect(() => assertSafeSnapshotName("C:\\Windows\\x")).toThrow(ActionableError);
  });

  it("refuses the bare traversal segments '.' and '..'", () => {
    expect(() => assertSafeSnapshotName("..")).toThrow(/traversal/i);
    expect(() => assertSafeSnapshotName(".")).toThrow(/traversal/i);
  });

  it("refuses empty, whitespace-only, and NUL-containing names", () => {
    expect(() => assertSafeSnapshotName("")).toThrow(ActionableError);
    expect(() => assertSafeSnapshotName("   ")).toThrow(ActionableError);
    expect(() => assertSafeSnapshotName("a\0b")).toThrow(/NUL/i);
  });

  it("accepts ordinary single-segment names, including dotted and spaced ones", () => {
    expect(() => assertSafeSnapshotName("snapshot_2026-08-25_12-00-00")).not.toThrow();
    expect(() => assertSafeSnapshotName("Pixel_5_baseline")).not.toThrow();
    expect(() => assertSafeSnapshotName("v1.0")).not.toThrow();
    expect(() => assertSafeSnapshotName("my snapshot")).not.toThrow();
    expect(() => assertSafeSnapshotName("..foo")).not.toThrow();
  });
});
