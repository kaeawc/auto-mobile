import { describe, expect, test } from "bun:test";
import { PlanDeviceActivity } from "../../src/daemon/planDeviceActivity";
import { ExecutionTracker } from "../../src/daemon/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import { createFakeSession } from "./helpers/inputSocketHarness";
import type { PlanExecutionTarget } from "../../src/utils/ServerConfig";

const LABELS = ["base", "base:B"];

function harness() {
  const session = createFakeSession("base", "old", "ios");
  const label = createFakeSession("base:B", "label-device", "android");
  // A labeled plan: its lease names the label sessions it allocates.
  const plans: PlanExecutionTarget[] = [
    { sessionUuid: "base", deviceId: "old", labelSessionUuids: LABELS },
  ];
  const tracker = new ExecutionTracker(new FakeTimer());
  const activity = new PlanDeviceActivity(
    {
      getAllSessions: () => [session, label],
      getDeviceLabels: (id) => (id === "base" ? { A: "base", B: "base:B" } : undefined),
    },
    { getActivePlanExecutions: () => plans },
    tracker,
  );
  return { activity, session, label, plans, tracker };
}

describe("plan device activity from execution leases", () => {
  test("current assignment and derived labels are protected before any adb call", () => {
    const h = harness();
    expect(h.activity.hasPlanExecution("old", "base")).toBe(true);
    expect(h.activity.hasPlanExecution("label-device", "base")).toBe(true);
    expect(h.activity.hasPlanExecution("old", "other")).toBe(false);
    expect(h.activity.hasPlanExecution("unrelated")).toBe(false);
    h.session.assignedDevice = "new";
    expect(h.activity.hasPlanExecution("new", "base")).toBe(true);
    expect(h.activity.hasPlanExecution("old")).toBe(false);
    h.plans.length = 0;
    expect(h.activity.hasPlanExecution("new")).toBe(false);
  });

  test("adb binding keeps earlier work protected when a plan switches mid-step", () => {
    const h = harness();
    const execution = h.tracker.startExecution("executePlan", undefined, "base");
    h.tracker.bindDeviceExecution(execution.id, "old");
    h.session.assignedDevice = "new";
    expect(h.activity.hasPlanExecution("old")).toBe(true);
    expect(h.activity.hasPlanExecution("new")).toBe(true);
    h.tracker.endExecution(execution.id);
    expect(h.activity.hasPlanExecution("old")).toBe(false);
    expect(h.activity.hasPlanExecution("new")).toBe(true);
  });

  test("loss binds the registered invocation to its switched device before scoped cancellation", async () => {
    const h = harness();
    const plan = h.tracker.startExecution("executePlan", undefined, "base");
    const other = h.tracker.startExecution("executePlan", undefined, "base");
    h.plans[0] = { sessionUuid: "base", deviceId: "old", executionId: plan.id };
    h.tracker.bindDeviceExecution(plan.id, "old");
    h.tracker.bindDeviceExecution(other.id, "other-device");
    h.session.assignedDevice = "new";
    expect(h.tracker.hasActiveDeviceExecutions("new")).toBe(false);
    h.activity.bindPlanExecutions("new", "base");
    await h.tracker.cancelDeviceExecutions("new", "device lost", {
      onlySessionUuid: "base",
      onlyToolName: "executePlan",
    });
    expect(plan.abortController.signal.aborted).toBe(true);
    expect(other.abortController.signal.aborted).toBe(false);
  });

  test("loss monitoring skips revoked bindings while admission still refuses them", async () => {
    const h = harness();
    const plan = h.tracker.startExecution("executePlan", undefined, "base");
    h.plans[0] = { sessionUuid: "base", executionId: plan.id };
    h.activity.bindPlanExecutions("old", "base");
    await h.tracker.cancelDeviceExecutions("old", "device lost", {
      onlySessionUuid: "base",
      onlyToolName: "executePlan",
    });
    expect(() => h.activity.bindPlanExecutions("old", "base")).not.toThrow();
    expect(() => h.tracker.bindDeviceExecution(plan.id, "old")).toThrow();
    expect(h.tracker.getActiveDeviceExecutionCount("old")).toBe(1);
  });

  test("broker-granted label holders resolve to the plan's base session", () => {
    const h = harness();
    // Broker allocation uses the existing base:B holder and publishes this same
    // label map before its allocation promise resolves; it mints no new session.
    h.plans[0] = { sessionUuid: "base", executionId: "broker-plan", labelSessionUuids: LABELS };
    expect(h.activity.hasPlanExecution(h.label.assignedDevice!, "base")).toBe(true);
    expect(h.activity.getPlanExecutionIds(h.label.assignedDevice!, "base")).toEqual([
      "broker-plan",
    ]);
    expect(h.activity.hasPlanExecution(h.label.assignedDevice!, "other")).toBe(false);
  });

  test("a single-device plan on A is not active on an unused sibling label B (#14444)", async () => {
    const h = harness();
    // The broker map {A: base, B: base:B} is published, but this invocation declared no labels:
    // it runs on A only, so B's loss must neither defer through it nor cancel it.
    const plan = h.tracker.startExecution("executePlan", undefined, "base");
    h.plans[0] = { sessionUuid: "base", deviceId: "old", executionId: plan.id };
    h.tracker.bindDeviceExecution(plan.id, "old");
    expect(h.activity.hasPlanExecution("old", "base")).toBe(true);
    expect(h.activity.hasPlanExecution("label-device")).toBe(false);
    expect(h.activity.hasPlanExecution("label-device", "base")).toBe(false);
    expect(h.activity.getPlanExecutionIds("label-device", "base")).toEqual([]);
    h.activity.bindPlanExecutions("label-device", "base");
    await h.tracker.cancelDeviceExecutions("label-device", "device lost", {
      onlySessionUuid: "base",
      onlyToolName: "executePlan",
    });
    expect(plan.abortController.signal.aborted).toBe(false);
  });

  test("a sessionless lease protects its explicit device", () => {
    const h = harness();
    h.plans.splice(0, 1, { deviceId: "sessionless" });
    expect(h.activity.hasPlanExecution("sessionless")).toBe(true);
    expect(h.activity.hasPlanExecution("unrelated")).toBe(false);
  });
});
