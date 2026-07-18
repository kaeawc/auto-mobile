import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GATE_LABEL,
  parseVouchCommand,
  planGateAction,
} from "../../../src/features/vouch/VouchGitHubGate";
import type { GateDecision } from "../../../src/features/vouch/types";

describe("parseVouchCommand", () => {
  test("parses invite", () => {
    expect(parseVouchCommand("/vouch invite")).toEqual({ kind: "invite" });
  });

  test("parses admit with and without @ and canonicalises the login", () => {
    expect(parseVouchCommand("/vouch admit @NewDev")).toEqual({ kind: "admit", target: "newdev" });
    expect(parseVouchCommand("/vouch admit newdev")).toEqual({ kind: "admit", target: "newdev" });
  });

  test("parses redeem with a token", () => {
    expect(parseVouchCommand("/vouch redeem abc-123")).toEqual({ kind: "redeem", token: "abc-123" });
  });

  test("parses denounce with a multi-word reason and a default reason", () => {
    expect(parseVouchCommand("/vouch denounce @baduser spamming issues")).toEqual({
      kind: "denounce",
      target: "baduser",
      reason: "spamming issues",
    });
    expect(parseVouchCommand("/vouch denounce baduser")).toEqual({
      kind: "denounce",
      target: "baduser",
      reason: "denounced via /vouch",
    });
  });

  test("parses status with and without a target", () => {
    expect(parseVouchCommand("/vouch status")).toEqual({ kind: "status", target: null });
    expect(parseVouchCommand("/vouch status @who")).toEqual({ kind: "status", target: "who" });
  });

  test("finds a command on any line and ignores surrounding prose", () => {
    const body = "Thanks!\n\n/vouch admit @friend\n\ncheers";
    expect(parseVouchCommand(body)).toEqual({ kind: "admit", target: "friend" });
  });

  test("returns null when there is no command or the verb is unknown", () => {
    expect(parseVouchCommand("just a normal comment")).toBeNull();
    expect(parseVouchCommand("/vouch frobnicate x")).toBeNull();
    expect(parseVouchCommand("/vouch admit")).toBeNull();
  });
});

describe("planGateAction", () => {
  const allowed: GateDecision = {
    login: "owner",
    allowed: true,
    reason: "founder",
    message: "'owner' is a trusted founder.",
  };
  const denied: GateDecision = {
    login: "stranger",
    allowed: false,
    reason: "unknown-actor",
    message: "'stranger' is not yet vouched for.",
  };

  test("allowed actors clear the gate label and stay silent", () => {
    const plan = planGateAction(allowed, { enforce: true });
    expect(plan.allowed).toBe(true);
    expect(plan.removeLabel).toBe(DEFAULT_GATE_LABEL);
    expect(plan.addLabel).toBeNull();
    expect(plan.comment).toBeNull();
    expect(plan.close).toBe(false);
  });

  test("advisory mode labels + comments but never closes", () => {
    const plan = planGateAction(denied, { enforce: false });
    expect(plan.addLabel).toBe(DEFAULT_GATE_LABEL);
    expect(plan.comment).toContain("not yet vouched");
    expect(plan.close).toBe(false);
  });

  test("enforcing mode closes the issue/PR", () => {
    const plan = planGateAction(denied, { enforce: true });
    expect(plan.close).toBe(true);
    expect(plan.comment).toContain("closed");
  });

  test("honours a custom gate label", () => {
    const plan = planGateAction(denied, { enforce: false, gateLabel: "gated" });
    expect(plan.addLabel).toBe("gated");
  });
});
