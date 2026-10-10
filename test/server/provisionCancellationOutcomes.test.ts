import { describe, expect, test } from "bun:test";
import {
  EARLY_OUTCOME_RETENTION_MS,
  ProvisionCancellationOutcomes,
} from "../../src/server/provisionCancellationOutcomes";
import { FakeTimer } from "../fakes/FakeTimer";

// #11092: a fast rollback can publish before the socket reply registers its waiter.
describe("ProvisionCancellationOutcomes", () => {
  test("an outcome published before the waiter registers is delivered once", async () => {
    const timer = new FakeTimer();
    const outcomes = new ProvisionCancellationOutcomes(timer);

    outcomes.publish("op", { code: "request_cancelled" });

    expect(await outcomes.await("op", 7_000, timer)).toEqual({ code: "request_cancelled" });
    expect(outcomes.isAwaiting("op")).toBe(false);
    const second = outcomes.await("op", 100, timer);
    timer.advanceTime(100);
    expect(await second).toBeUndefined();
  });

  test("an early outcome expires after the retention window", async () => {
    const timer = new FakeTimer();
    const outcomes = new ProvisionCancellationOutcomes(timer);

    outcomes.publish("op", "late");
    timer.advanceTime(EARLY_OUTCOME_RETENTION_MS + 1);

    const waiting = outcomes.await("op", 100, timer);
    timer.advanceTime(100);
    expect(await waiting).toBeUndefined();
  });

  // #11111: a quiet daemon must not retain unclaimed outcomes until some later publish.
  test("isAwaiting and await prune expired unclaimed outcomes without a publish", async () => {
    const timer = new FakeTimer();
    const outcomes = new ProvisionCancellationOutcomes(timer);

    outcomes.publish("a", 1);
    outcomes.publish("b", 2);
    timer.advanceTime(EARLY_OUTCOME_RETENTION_MS + 1);
    expect(outcomes.retainedEarlyCount).toBe(2);

    expect(outcomes.isAwaiting("c")).toBe(false);
    expect(outcomes.retainedEarlyCount).toBe(0);

    outcomes.publish("d", 3);
    timer.advanceTime(EARLY_OUTCOME_RETENTION_MS + 1);
    const waiting = outcomes.await("e", 100, timer);
    expect(outcomes.retainedEarlyCount).toBe(0);
    timer.advanceTime(100);
    expect(await waiting).toBeUndefined();
  });
});
