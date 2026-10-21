import { beforeEach, describe, expect, test } from "bun:test";
import { PlanLabelRegistry } from "../../src/daemon/planLabelRegistry";

describe("PlanLabelRegistry", () => {
  let live: Set<string>;
  let registry: PlanLabelRegistry;
  const terminal = (reason: string): boolean => reason === "plan-auto-release";

  beforeEach(() => {
    live = new Set();
    registry = new PlanLabelRegistry({ hasSession: (id) => live.has(id) });
  });

  test("indexes derived labels, excluding the base itself, and merges repeats", () => {
    registry.indexDerivedLabels("base", { a: "base", b: "base:b" });
    registry.indexDerivedLabels("base", { c: "base:c" });
    registry.indexDerivedLabels("other", { a: "other" });
    expect(registry.getBaseSessionOfDerivedLabel("base:b")).toBe("base");
    expect(registry.getBaseSessionOfDerivedLabel("base:c")).toBe("base");
    expect(registry.getBaseSessionOfDerivedLabel("base")).toBeUndefined();
    expect(registry.getBaseSessionOfDerivedLabel("other")).toBeUndefined();
  });

  test("mint windows are counted per open run and close idempotently", () => {
    const closeA = registry.openPlanLabelMints("base", { a: "base:a", self: "base" });
    const closeB = registry.openPlanLabelMints("base", { a: "base:a" });
    expect(registry.isMinting("base:a")).toBe(true);
    expect(registry.isMinting("base")).toBe(false);
    closeA();
    closeA();
    expect(registry.isMinting("base:a")).toBe(true);
    closeB();
    expect(registry.isMinting("base:a")).toBe(false);
  });

  test("creatorSource marks only minting sessions", () => {
    registry.openPlanLabelMints("base", { a: "base:a" });
    expect(registry.creatorSource("base:a", "mcp", "plan-label")).toBe("plan-label");
    expect(registry.creatorSource("base:z", "mcp", "plan-label")).toBe("mcp");
  });

  test("isMintableAndNotLive needs a mint window and no published session", () => {
    registry.openPlanLabelMints("base", { a: "base:a" });
    expect(registry.isMintableAndNotLive("base:a")).toBe(true);
    live.add("base:a");
    expect(registry.isMintableAndNotLive("base:a")).toBe(false);
    expect(registry.isMintableAndNotLive("base:z")).toBe(false);
  });

  test("liveBaseOfDerivedId returns the longest live prefix", () => {
    const isLive = (c: string): boolean => c === "a" || c === "a:b";
    expect(registry.liveBaseOfDerivedId("a:b:c", isLive)).toBe("a:b");
    expect(registry.liveBaseOfDerivedId("a:x", isLive)).toBe("a");
    expect(registry.liveBaseOfDerivedId("z:x", isLive)).toBeUndefined();
    expect(registry.liveBaseOfDerivedId("a", isLive)).toBeUndefined();
  });

  test("markRunning / isRunning", () => {
    expect(registry.isRunning("base:a")).toBe(false);
    registry.markRunning("base:a");
    expect(registry.isRunning("base:a")).toBe(true);
  });

  test("take returns and clears the index, retains ended bases for live labels, ends running", () => {
    registry.indexDerivedLabels("base", { a: "base:a", b: "base:b" });
    registry.markRunning("base:a");
    registry.markRunning("base:b");
    live.add("base:a");
    expect(registry.takeDerivedLabelSessions("base", "plan-auto-release", terminal).sort()).toEqual(
      ["base:a", "base:b"],
    );
    expect(registry.retainedEndedBase("base:a")).toEqual({
      baseSessionId: "base",
      releaseReason: "plan-auto-release",
    });
    expect(registry.retainedEndedBase("base:b")).toBeUndefined();
    expect(registry.isRunning("base:a")).toBe(false);
    expect(registry.isRunning("base:b")).toBe(false);
    expect(registry.getBaseSessionOfDerivedLabel("base:a")).toBeUndefined();
    expect(registry.takeDerivedLabelSessions("base", "plan-auto-release", terminal)).toEqual([]);
  });

  test("take retains nothing for a non-terminal or absent reason", () => {
    registry.indexDerivedLabels("base", { a: "base:a" });
    live.add("base:a");
    expect(registry.takeDerivedLabelSessions("base", "idle", terminal)).toEqual(["base:a"]);
    expect(registry.retainedEndedBase("base:a")).toBeUndefined();
    registry.indexDerivedLabels("base", { a: "base:a" });
    registry.takeDerivedLabelSessions("base", undefined, terminal);
    expect(registry.retainedEndedBase("base:a")).toBeUndefined();
  });

  test("clearEndedBase drops a retained end", () => {
    registry.indexDerivedLabels("base", { a: "base:a" });
    live.add("base:a");
    registry.takeDerivedLabelSessions("base", "plan-auto-release", terminal);
    registry.clearEndedBase("base:a");
    expect(registry.retainedEndedBase("base:a")).toBeUndefined();
  });
});
