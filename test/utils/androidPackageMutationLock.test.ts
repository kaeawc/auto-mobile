import { describe, expect, test } from "bun:test";
import { withAndroidPackageMutationLock } from "../../src/utils/androidPackageMutationLock";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("withAndroidPackageMutationLock", () => {
  test("runs mutations on one device one at a time, in order", async () => {
    const events: string[] = [];
    const gate = deferred();
    const first = withAndroidPackageMutationLock("d1", undefined, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = withAndroidPackageMutationLock("d1", undefined, async () => {
      events.push("second:start");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("different devices do not block each other", async () => {
    const gate = deferred();
    const blocked = withAndroidPackageMutationLock("d-a", undefined, () => gate.promise);
    let ran = false;
    await withAndroidPackageMutationLock("d-b", undefined, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    gate.resolve();
    await blocked;
  });

  test("a caller that left while queued never starts its mutation", async () => {
    const gate = deferred();
    const holder = withAndroidPackageMutationLock("d2", undefined, () => gate.promise);
    const controller = new AbortController();
    let started = false;
    const queued = withAndroidPackageMutationLock("d2", controller.signal, async () => {
      started = true;
    });
    controller.abort();
    gate.resolve();
    await holder;
    await expect(queued).rejects.toBeDefined();
    expect(started).toBe(false);
  });

  test("a failed mutation releases the lock", async () => {
    await expect(
      withAndroidPackageMutationLock("d3", undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withAndroidPackageMutationLock("d3", undefined, async () => "ok")).toBe("ok");
  });
});
