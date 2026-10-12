import { describe, expect, mock, test } from "bun:test";
import { createLockOwnerGenerationProbe } from "../../src/daemon/lockOwnerGeneration";
import { FakeTimer } from "../fakes/FakeTimer";

describe("lock owner generation probe", () => {
  test.each(["linux", "darwin"] as const)("routes %s to its existing reader", (platform) => {
    const linux = mock(() => "linux:boot:10");
    const darwin = mock(() => "darwin-utc:Tue Oct 6 07:35:51 2026");
    const probe = createLockOwnerGenerationProbe({
      platform,
      readLinuxProcessGenerationToken: linux,
      readDarwinProcessGenerationToken: darwin,
      captureDisabled: () => false,
    });
    const token = platform === "linux" ? "linux:boot:10" : "darwin-utc:Tue Oct 6 07:35:51 2026";
    expect(probe.current(10)).toBe(token);
    expect(probe.compare(10, token)).toBe("same");
    expect(platform === "linux" ? linux.mock.calls : darwin.mock.calls).toEqual([[10], [10]]);
    expect(platform === "linux" ? darwin : linux).not.toHaveBeenCalled();
  });

  test("win32 retains PID-only behavior without a reader call", () => {
    const reader = mock(() => "unused");
    const probe = createLockOwnerGenerationProbe({
      platform: "win32",
      readLinuxProcessGenerationToken: reader,
      readDarwinProcessGenerationToken: reader,
      captureDisabled: () => false,
    });
    expect(probe.current(10)).toBeUndefined();
    expect(probe.compare(10, "linux:boot:10")).toBe("unknown");
    expect(reader).not.toHaveBeenCalled();
  });

  test.each(["undefined", "throws"] as const)("an %s reader sample is unknown", (result) => {
    const reader = mock(() => {
      if (result === "throws") {
        throw new Error("sample denied");
      }
      return undefined;
    });
    const probe = createLockOwnerGenerationProbe({
      platform: "linux",
      readLinuxProcessGenerationToken: reader,
      captureDisabled: () => false,
    });
    expect(probe.current(10)).toBeUndefined();
    expect(probe.compare(10, "linux:boot:10")).toBe("unknown");
    expect(reader).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["darwin:Tue Oct 6 07:35:51 2026", "darwin-utc:Tue Oct 6 07:35:51 2026", "unknown"],
    ["linux:boot:10", "darwin-utc:Tue Oct 6 07:35:51 2026", "unknown"],
    ["linux:boot:10", "linux:boot:20", "different"],
    ["darwin-utc:Tue Oct 6 07:35:51 2026", "darwin-utc:Tue Oct 6 08:35:51 2026", "different"],
  ])("compares %s against %s as %s", (recorded, fresh, verdict) => {
    const reader = mock(() => fresh);
    const probe = createLockOwnerGenerationProbe({
      platform: "linux",
      readLinuxProcessGenerationToken: reader,
      captureDisabled: () => false,
    });
    expect(probe.compare(10, recorded)).toBe(verdict);
    expect(probe.compare(10, recorded)).toBe(verdict);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  test("same is memoised below the default TTL and freshly read at the boundary", () => {
    const timer = new FakeTimer();
    const reader = mock(() => "linux:boot:10");
    const probe = createLockOwnerGenerationProbe({
      platform: "linux",
      readLinuxProcessGenerationToken: reader,
      now: () => timer.now(),
      captureDisabled: () => false,
    });
    expect(probe.compare(10, "linux:boot:10")).toBe("same");
    timer.advanceTime(999);
    expect(probe.compare(10, "linux:boot:10")).toBe("same");
    expect(reader).toHaveBeenCalledTimes(1);
    timer.advanceTime(1);
    expect(probe.compare(10, "linux:boot:10")).toBe("same");
    expect(reader).toHaveBeenCalledTimes(2);
  });

  test("a custom TTL expires same and never retains different", () => {
    const timer = new FakeTimer();
    let fresh = "linux:boot:10";
    const reader = mock(() => fresh);
    const probe = createLockOwnerGenerationProbe({
      platform: "linux",
      readLinuxProcessGenerationToken: reader,
      now: () => timer.now(),
      sameVerdictTtlMs: 20,
      captureDisabled: () => false,
    });
    expect(probe.compare(10, fresh)).toBe("same");
    fresh = "linux:boot:20";
    timer.advanceTime(20);
    expect(probe.compare(10, "linux:boot:10")).toBe("different");
    expect(probe.compare(10, "linux:boot:10")).toBe("different");
    expect(reader).toHaveBeenCalledTimes(3);
    fresh = "linux:boot:10";
    expect(probe.compare(10, fresh)).toBe("same");
    expect(reader).toHaveBeenCalledTimes(4);
  });

  test("memoised token A never answers for B and a non-same verdict drops A", () => {
    const reader = mock(() => "linux:boot:A");
    const probe = createLockOwnerGenerationProbe({
      platform: "linux",
      readLinuxProcessGenerationToken: reader,
      now: () => 0,
      captureDisabled: () => false,
    });
    expect(probe.compare(10, "linux:boot:A")).toBe("same");
    expect(probe.compare(10, "linux:boot:B")).toBe("different");
    expect(reader).toHaveBeenCalledTimes(2);
    expect(probe.compare(10, "linux:boot:B")).toBe("different");
    expect(reader).toHaveBeenCalledTimes(3);
    expect(probe.compare(10, "linux:boot:A")).toBe("same");
    expect(reader).toHaveBeenCalledTimes(4);
  });

  test("a different PID never uses another PID's memo", () => {
    const reader = mock(() => "linux:boot:A");
    const probe = createLockOwnerGenerationProbe({
      platform: "linux",
      readLinuxProcessGenerationToken: reader,
      now: () => 0,
      captureDisabled: () => false,
    });
    expect(probe.compare(10, "linux:boot:A")).toBe("same");
    expect(probe.compare(20, "linux:boot:A")).toBe("same");
    expect(reader.mock.calls).toEqual([[10], [20]]);
  });

  test("current retries undefined, caches the first defined token per PID, and never supplies compare", () => {
    let fresh: string | undefined;
    const reader = mock(() => fresh);
    const probe = createLockOwnerGenerationProbe({
      platform: "linux",
      readLinuxProcessGenerationToken: reader,
      captureDisabled: () => false,
    });
    expect(probe.current(10)).toBeUndefined();
    fresh = "linux:boot:A";
    expect(probe.current(10)).toBe(fresh);
    fresh = "linux:boot:B";
    expect(probe.current(10)).toBe("linux:boot:A");
    expect(reader).toHaveBeenCalledTimes(2);
    expect(probe.compare(10, "linux:boot:B")).toBe("same");
    expect(reader).toHaveBeenCalledTimes(3);
    expect(probe.current(20)).toBe("linux:boot:B");
    expect(reader).toHaveBeenCalledTimes(4);
  });

  test("captureDisabled is evaluated on every call, including cached current and same", () => {
    let disabled = true;
    const reader = mock(() => "darwin-utc:Tue Oct 6 07:35:51 2026");
    const probe = createLockOwnerGenerationProbe({
      platform: "darwin",
      readDarwinProcessGenerationToken: reader,
      now: () => 0,
      captureDisabled: () => disabled,
    });
    const token = "darwin-utc:Tue Oct 6 07:35:51 2026";
    expect(probe.current(10)).toBeUndefined();
    expect(probe.compare(10, token)).toBe("unknown");
    expect(reader).not.toHaveBeenCalled();
    disabled = false;
    expect(probe.current(10)).toBe(token);
    expect(probe.compare(10, token)).toBe("same");
    expect(reader).toHaveBeenCalledTimes(2);
    disabled = true;
    expect(probe.current(10)).toBeUndefined();
    expect(probe.compare(10, token)).toBe("unknown");
    expect(reader).toHaveBeenCalledTimes(2);
    disabled = false;
    expect(probe.current(10)).toBe(token);
    expect(probe.compare(10, token)).toBe("same");
    expect(reader).toHaveBeenCalledTimes(3);
  });
});
