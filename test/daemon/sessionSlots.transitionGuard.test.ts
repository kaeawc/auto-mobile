import { expect, test } from "bun:test";
import { SlotTransitionGuard, SlotTransitionError } from "../../src/daemon/sessionSlots";
import { FakeLogger } from "../fakes/FakeLogger";

function fixture() {
  const logger = new FakeLogger();
  const guard = new SlotTransitionGuard(logger);
  return { logger, guard };
}

test("an impossible hook transition throws in test mode and counts it", () => {
  const { guard, logger } = fixture();
  guard.check("id", "creation-start", { tag: "creating" }, "throw");
  expect(() => guard.check("id", "rebind-start", { tag: "rebinding" }, "throw")).toThrow(
    SlotTransitionError,
  );
  expect(guard.illegalTransitionCount).toBe(1);
  expect(logger.at("warn")).toEqual([]);
});

test("production warns, counts and continues from the observed position", () => {
  const { guard, logger } = fixture();
  guard.check("id", "creation-start", { tag: "creating" }, "log");
  expect(() => guard.check("id", "rebind-start", { tag: "rebinding" }, "log")).not.toThrow();
  expect(guard.illegalTransitionCount).toBe(1);
  expect(logger.at("warn")[0]?.message).toContain(
    "uuid=id event=rebind-start: creating -> rebinding",
  );
  guard.check("id", "rebind-end", { tag: "live" }, "log");
  expect(guard.illegalTransitionCount).toBe(1);
});

test("unchanged hooks and fence upgrades are legal; a fence downgrade still throws", () => {
  const { guard } = fixture();
  guard.check("id", "creation-start", { tag: "creating" }, "throw");
  guard.check("id", "published", { tag: "live" }, "throw");
  guard.check("id", "creation-end", { tag: "live" }, "throw");
  guard.check("id", "release-start", { tag: "releasing", fence: "none" }, "throw");
  guard.check("id", "release-start", { tag: "releasing", fence: "terminal" }, "throw");
  expect(guard.illegalTransitionCount).toBe(0);
  expect(() =>
    guard.check("id", "release-end", { tag: "releasing", fence: "none" }, "throw"),
  ).toThrow(SlotTransitionError);
});

const coarse = [
  ["published", "absent", "live"],
  ["assignment-end", "assigning", "fenced"],
  ["creation-end", "creating", "fenced"],
  ["unpublished", "releasing", "creating"],
] as const;

test.each(coarse)(
  "coarse %s: %s -> %s logs at debug and counts in throw mode",
  (event, from, to) => {
    const { guard, logger } = fixture();
    if (from === "assigning" || from === "creating") {
      guard.check("id", `${from}-start`, { tag: from }, "throw");
    }
    if (from === "releasing") {
      guard.check("id", "creation-start", { tag: "creating" }, "throw");
      guard.check("id", "release-start", { tag: "releasing", fence: "none" }, "throw");
    }
    guard.check("id", event, { tag: to }, "throw");
    expect(guard.illegalTransitionCount).toBe(1);
    expect(logger.at("debug")).toHaveLength(1);
    expect(logger.at("warn")).toEqual([]);
  },
);

const findings = [
  ["assignment-start", "ended", "assigning"],
  ["assignment-end", "assigning", "ended"],
  ["creation-end", "creating", "assigning"],
  ["creation-end", "creating", "ended"],
  ["unpublished", "releasing", "assigning"],
  ["release-end", "ended", "fenced"],
  ["release-end", "ended", "live"],
] as const;

test.each(findings)(
  "reported finding %s: %s -> %s logs at debug and counts even in throw mode",
  (event, from, to) => {
    const { guard, logger } = fixture();
    guard.check("id", "creation-start", { tag: "creating" }, "throw");
    if (from === "assigning") {
      guard.forget("id");
      guard.check("id", "assignment-start", { tag: "assigning" }, "throw");
    } else if (from === "ended" || from === "releasing") {
      guard.check("id", "release-start", { tag: "releasing", fence: "none" }, "throw");
      if (from === "ended") {
        guard.check("id", "unpublished", { tag: "ended" }, "throw");
      }
    }
    guard.check("id", event, { tag: to }, "throw");
    expect(guard.illegalTransitionCount).toBe(1);
    expect(logger.at("debug")).toHaveLength(1);
    expect(logger.at("warn")).toEqual([]);
  },
);

test("reported pairs are scoped to their observed hook, never a blanket transition allowance", () => {
  const { guard } = fixture();
  guard.check("id", "creation-start", { tag: "creating" }, "throw");
  expect(() => guard.check("id", "published", { tag: "assigning" }, "throw")).toThrow();
});

test("UUID positions are independent, and finalization forgets an ended identity", () => {
  const { guard } = fixture();
  guard.check("a", "creation-start", { tag: "creating" }, "throw");
  guard.check("b", "assignment-start", { tag: "assigning" }, "throw");
  guard.check("a", "release-start", { tag: "releasing", fence: "none" }, "throw");
  guard.check("a", "unpublished", { tag: "ended" }, "throw");
  guard.forget("a");
  guard.check("a", "assignment-start", { tag: "assigning" }, "throw");
  expect(guard.illegalTransitionCount).toBe(0);
});
