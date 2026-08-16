import { describe, expect, test } from "bun:test";
import { runShutdownCleanupStages, type ShutdownCleanupStage } from "../src/shutdownCleanup";

const stageNames = ["socket", "helpers", "database", "logger"] as const;

function createStages(
  calls: string[],
  failures: ReadonlyMap<string, Error>,
): ShutdownCleanupStage[] {
  return stageNames.map((name) => ({
    name,
    run: async () => {
      calls.push(name);
      const failure = failures.get(name);
      if (failure) {
        throw failure;
      }
    },
  }));
}

describe("runShutdownCleanupStages", () => {
  for (const failingStage of stageNames) {
    test(`runs every cleanup stage exactly once when ${failingStage} fails`, async () => {
      const calls: string[] = [];
      const failure = new Error(`${failingStage} failed`);
      const warnings: Array<{ message: string; error: unknown }> = [];

      await expect(
        runShutdownCleanupStages(
          createStages(calls, new Map([[failingStage, failure]])),
          (message, error) => warnings.push({ message, error }),
        ),
      ).rejects.toBeInstanceOf(AggregateError);

      expect(calls).toEqual(stageNames);
      expect(warnings).toEqual([
        {
          message: `Shutdown cleanup stage ${failingStage} failed`,
          error: failure,
        },
      ]);
    });
  }

  test("aggregates all failures after every stage has run", async () => {
    const calls: string[] = [];
    const firstFailure = new Error("socket failed");
    const lastFailure = new Error("logger failed");
    let aggregate: unknown;

    try {
      await runShutdownCleanupStages(
        createStages(
          calls,
          new Map([
            ["socket", firstFailure],
            ["logger", lastFailure],
          ]),
        ),
        () => {},
      );
    } catch (error) {
      aggregate = error;
    }

    expect(calls).toEqual(stageNames);
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toEqual([firstFailure, lastFailure]);
  });

  test("resolves without logging when every cleanup stage succeeds", async () => {
    const calls: string[] = [];
    const warnings: Array<{ message: string; error: unknown }> = [];

    await expect(
      runShutdownCleanupStages(createStages(calls, new Map()), (message, error) =>
        warnings.push({ message, error }),
      ),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(stageNames);
    expect(warnings).toEqual([]);
  });
});
