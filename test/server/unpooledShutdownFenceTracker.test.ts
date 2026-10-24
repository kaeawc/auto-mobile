import { expect, test } from "bun:test";
import { createUnpooledFenceTracker } from "../../src/server/unpooledShutdownFenceTracker";
import { UnpooledShutdownFences } from "../../src/daemon/unpooledShutdownFences";
import { FakeTimer } from "../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  const fences = new UnpooledShutdownFences(() => timer.now());
  fences.record("device");
  const tracker = createUnpooledFenceTracker(
    {
      clearUnpooledShutdown: (id) => fences.clear(id),
      settleUnpooledShutdown: (id) => fences.settle(id),
    },
    "device",
  );
  return { timer, fences, tracker };
}

test("pre-kill clear prevents final settlement from recreating the fence", () => {
  const { fences, tracker } = harness();
  tracker.clear();
  tracker.settle();
  expect(fences.isActive("device")).toBe(false);
});

test.each(["success", "failure"] as const)(
  "retained late kill holds until %s then starts discovery grace",
  async (outcome) => {
    const { timer, fences, tracker } = harness();
    const late = Promise.withResolvers<void>();
    const retained: Promise<unknown>[] = [];
    const retain = tracker.wrapRetain((operation) => {
      retained.push(operation);
    });
    retain(late.promise, true);
    tracker.settle();
    timer.advanceTime(31_000);
    expect(fences.isActive("device")).toBe(true);
    if (outcome === "success") {
      late.resolve();
      await retained[0];
    } else {
      late.reject(new Error("late command failed"));
      await expect(retained[0]).rejects.toThrow("late command failed");
    }
    timer.advanceTime(29_999);
    expect(fences.isActive("device")).toBe(true);
    timer.advanceTime(1);
    expect(fences.isActive("device")).toBe(false);
  },
);
