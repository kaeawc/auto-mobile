import { expect, spyOn, test } from "bun:test";
import { createStressHarness, runStressOperations } from "../../scripts/memory/stress-harness";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

test("stress harness dispatches one tap with the typed legacy call shape", async () => {
  const start = performance.now();
  const harness = await createStressHarness();
  console.info(`createStressHarness: ${(performance.now() - start).toFixed(2)}ms`);
  const adb = spyOn(FakeAdbExecutor.prototype, "executeCommand");
  const tap = spyOn(
    AndroidCtrlProxyClient.getInstance(harness.resources.device),
    "requestTapCoordinates",
  ).mockResolvedValue({ success: false, error: "Fake pre-dispatch rejection" });
  try {
    const result = await runStressOperations(harness, {
      iterations: 1,
      opsPerSecond: 0,
      operations: ["tapOn"],
      gcEvery: 0,
    });
    expect(result.operationCounts.tapOn).toBe(1);
    expect(
      adb.mock.calls.some(([command]) => command === "shell input touchscreen tap 10 10"),
    ).toBe(true);
  } finally {
    tap.mockRestore();
    adb.mockRestore();
    await harness.cleanup();
  }
});
