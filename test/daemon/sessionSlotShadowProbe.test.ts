import { expect, test } from "bun:test";
import {
  SessionSlotShadowProbe,
  type LegacySlotPredicates,
} from "../../src/daemon/sessionSlotShadowProbe";
import { deriveSlot, isSlotKnown, isSlotTagBeingRecreated } from "../../src/daemon/sessionSlots";
import { FakeLegacyLifecycleView } from "../fakes/FakeLegacyLifecycleView";
import { FakeLogger } from "../fakes/FakeLogger";

function fixture() {
  const session = {};
  const view = new FakeLegacyLifecycleView().publish("id", session);
  const legacy: LegacySlotPredicates<object> = {
    isCurrentSession: () => true,
    isAdmittedForAutomation: () => true,
    isLatestSessionIdentity: (s) => s === session,
    isSessionBeingRecreated: () => true,
    isKnownSessionId: () => true,
  };
  const logger = new FakeLogger();
  const probe = new SessionSlotShadowProbe(() => view, legacy, logger);
  return { session, view, legacy, logger, probe };
}

test("throw reports uuid, event, derived slot and legacy values", () => {
  const { probe, legacy } = fixture();
  probe.mode = "throw";
  probe.check("id", "agrees");
  legacy.isCurrentSession = () => false;
  expect(() => probe.check("id", "published")).toThrow(
    /uuid=id event=published slot=.*live.*legacy=/,
  );
});

test("production defaults to log and reports disagreement at debug", () => {
  const { probe, legacy, logger } = fixture();
  expect(probe.mode).toBe("log");
  legacy.isKnownSessionId = () => false;
  probe.check("id", "release");
  expect(logger.at("debug")).toHaveLength(1);
  expect(logger.at("warn")).toHaveLength(0);
});

test("log catches derivation failures and warns; throw propagates", () => {
  const { probe, view, logger } = fixture();
  view.isReleasing = () => {
    throw new Error("broken view");
  };
  expect(() => probe.check("id", "release")).not.toThrow();
  expect(logger.at("warn")[0]?.message).toContain("uuid=id event=release: broken view");
  probe.mode = "throw";
  expect(() => probe.check("id", "release")).toThrow("broken view");
});

test("off does not read either view or predicates", () => {
  const logger = new FakeLogger();
  const { legacy } = fixture();
  const probe = new SessionSlotShadowProbe<object>(
    () => {
      throw new Error("must not read");
    },
    legacy,
    logger,
  );
  probe.mode = "off";
  probe.check("id", "ignored");
  expect(logger.messages).toEqual([]);
});

test("gap 1: releasing published incarnation is still being recreated", () => {
  const { session, view, legacy, probe } = fixture();
  view.releasingSessions.add(session);
  legacy.isAdmittedForAutomation = () => false;
  probe.mode = "throw";
  probe.check("id", "weakset-before-op");
  expect(isSlotTagBeingRecreated(deriveSlot(view, "id").tag)).toBe(true);
});

test("gap 2: declined commit with terminal fence keeps current and admission false", () => {
  const { view, legacy, probe } = fixture();
  view.startRelease("id", { commitDeclined: true }).fenceTerminal("id");
  legacy.isCurrentSession = () => false;
  legacy.isAdmittedForAutomation = () => false;
  probe.mode = "throw";
  probe.check("id", "declined");
  expect(deriveSlot(view, "id")).toEqual({
    tag: "releasing",
    fence: "terminal",
    releaseRequested: false,
  });
  view.releaseOps.clear();
  probe.check("id", "fence-without-op");
});

test.each(["rebind", "release"])("gap 3: orphan %s is known residue", (kind) => {
  const { view, legacy, probe } = fixture();
  view.sessions.clear();
  if (kind === "rebind") {
    view.startRebind("id");
  } else {
    view.requestRelease("id");
  }
  legacy.isSessionBeingRecreated = () => false;
  probe.mode = "throw";
  probe.check("id", "orphan");
  expect(deriveSlot(view, "id")).toEqual({ tag: "absent", residue: true, releaseRequested: false });
  expect(isSlotKnown(deriveSlot(view, "id"))).toBe(true);
});

test("latest identity disagreement also names retained older incarnations", () => {
  const { probe, legacy, session } = fixture();
  const older = {};
  probe.mode = "throw";
  probe.check("id", "reissued", [older]);
  legacy.isLatestSessionIdentity = (s) => s === session || s === older;
  expect(() => probe.check("id", "reissued", [older])).toThrow(
    /identities=.*"derived":false,"legacy":true/,
  );
});
