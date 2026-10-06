import { describe, expect, test } from "bun:test";
import { PerFileAndroidSharedPreferencesMutationCoordinator } from "../../../src/features/preferences/AndroidSharedPreferencesMutationCoordinator";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("PerFileAndroidSharedPreferencesMutationCoordinator user scoping (#9919)", () => {
  test("serializes mutations of the same user's file, treating an omitted user as user 0", async () => {
    const coordinator = new PerFileAndroidSharedPreferencesMutationCoordinator();
    const order: string[] = [];
    const gate = deferred();

    const first = coordinator.run("dev", "app", "prefs", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = coordinator.run(
      "dev",
      "app",
      "prefs",
      async () => {
        order.push("second");
      },
      0,
    );

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("does not make one user's mutation wait on another user's file", async () => {
    const coordinator = new PerFileAndroidSharedPreferencesMutationCoordinator();
    const order: string[] = [];
    const gate = deferred();

    const owner = coordinator.run("dev", "app", "prefs", async () => {
      await gate.promise;
      order.push("owner");
    });
    const work = coordinator.run(
      "dev",
      "app",
      "prefs",
      async () => {
        order.push("work");
      },
      10,
    );

    await work;
    expect(order).toEqual(["work"]);
    gate.resolve();
    await owner;
    expect(order).toEqual(["work", "owner"]);
  });
});
