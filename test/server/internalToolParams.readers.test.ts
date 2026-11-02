import { describe, expect, test } from "bun:test";
import {
  adoptRestartResumeSessionUuid,
  adoptRestartResumeTargets,
  internalLiveDeadlineKey,
  internalMcpSessionId,
  internalOneShotCli,
  internalRestartResumeSessionUuid,
  internalRestartResumeTargets,
} from "../../src/server/internalToolParams";
import { deviceCallRecording } from "../../src/server/pipeline/deviceCallDispatch";
import type { TapAtPlanContext } from "../../src/models/TapAtGeometry";
import {
  currentExecution,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";

describe("call execution identity (#15663)", () => {
  test("is the ambient execution, inherited by a nested call", async () => {
    const execution = { executionId: "exec-1", startTime: 42 };
    const seen = await runWithToolSelectionContext({ execution }, () =>
      runWithToolSelectionContext({ routingSessionUuid: "s1" }, async () => currentExecution()),
    );
    expect(seen).toBe(execution);
  });

  test("is absent outside a tool call, whatever the args carry", () => {
    expect(currentExecution()).toBeUndefined();
  });
});

describe("internal call identity readers", () => {
  test("read the in-band keys a handler's args carry", () => {
    expect(internalMcpSessionId({ __mcpSessionId: "mcp-1" })).toBe("mcp-1");
  });

  test("an absent key reads as absent", () => {
    expect(internalMcpSessionId({})).toBeUndefined();
  });

  test("a value of the wrong type reads as absent", () => {
    expect(internalMcpSessionId({ __mcpSessionId: null })).toBeUndefined();
  });

  test("a blank connection identity is still a string, as the stages read it today", () => {
    expect(internalMcpSessionId({ __mcpSessionId: "" })).toBe("");
  });
});

describe("start-device handoff readers", () => {
  test("one-shot CLI is only an exact true", () => {
    expect(internalOneShotCli({ __oneShotCli: true })).toBe(true);
    expect(internalOneShotCli({ __oneShotCli: "true" })).toBe(false);
    expect(internalOneShotCli({})).toBe(false);
  });

  test("restart-resume fields read through with their declared types", () => {
    const targets = [{ sessionId: "s1" }] as const;
    const args = { __restartResumeTargets: targets, __restartResumeSessionUuid: "s1" };
    expect(internalRestartResumeTargets(args)).toBe(targets);
    expect(internalRestartResumeSessionUuid(args)).toBe("s1");
    expect(internalRestartResumeTargets({})).toBeUndefined();
    expect(internalRestartResumeSessionUuid({})).toBeUndefined();
  });

  test("adopting restart-resume targets never replaces ones the start already carries", () => {
    const carried: { __restartResumeTargets?: string[] } = { __restartResumeTargets: ["mine"] };
    adoptRestartResumeTargets(carried, ["other"]);
    expect(carried.__restartResumeTargets).toEqual(["mine"]);
    const empty: { __restartResumeTargets?: string[] } = {};
    adoptRestartResumeTargets(empty, ["other"]);
    expect(empty.__restartResumeTargets).toEqual(["other"]);
  });
});

describe("provisioning handoff readers", () => {
  test("the live deadline key reads only a string", () => {
    expect(internalLiveDeadlineKey({ __mcpLiveDeadlineKey: "k1" })).toBe("k1");
    expect(internalLiveDeadlineKey({ __mcpLiveDeadlineKey: 1 })).toBeUndefined();
    expect(internalLiveDeadlineKey({})).toBeUndefined();
  });

  test("adopting a resume session never replaces one the args already name", () => {
    const named: { __restartResumeSessionUuid?: string } = { __restartResumeSessionUuid: "mine" };
    adoptRestartResumeSessionUuid(named, "other");
    expect(named.__restartResumeSessionUuid).toBe("mine");
    const empty: { __restartResumeSessionUuid?: string } = {};
    adoptRestartResumeSessionUuid(empty, "other");
    expect(empty.__restartResumeSessionUuid).toBe("other");
  });
});

describe("coordinate gesture recording context (#15663)", () => {
  test("a tapAt records into the plan step's geometry context, by reference", () => {
    const plan: TapAtPlanContext = {};
    expect(deviceCallRecording("tapAt", { tapAtPlanContext: plan })?.tapAt).toBe(plan);
  });

  test("a tapAt outside a plan step gets a fresh context the handler fills", () => {
    expect(deviceCallRecording("tapAt", undefined)).toEqual({ tapAt: {} });
  });

  test("a swipeAt gets a fresh screen context and other tools record nothing extra", () => {
    expect(deviceCallRecording("swipeAt", { tapAtPlanContext: {} })).toEqual({ swipeAt: {} });
    expect(deviceCallRecording("tapOn", { tapAtPlanContext: {} })).toBeUndefined();
  });
});
