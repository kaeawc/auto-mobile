import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RequestManager } from "../../src/utils/RequestManager";
import { FakeTimer } from "../fakes/FakeTimer";

describe("RequestManager", () => {
  let manager: RequestManager;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    manager = new RequestManager(fakeTimer);
  });

  afterEach(() => {
    manager.reset();
  });

  test("should generate unique request IDs", () => {
    const id1 = manager.generateId("screenshot");
    const id2 = manager.generateId("screenshot");
    const id3 = manager.generateId("swipe");

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).toContain("screenshot");
    expect(id3).toContain("swipe");
  });

  test("should register and resolve requests", async () => {
    const id = manager.generateId("test");
    const promise = manager.register<{ success: boolean }>(id, "test", 5000, () => ({
      success: false,
    }));

    expect(manager.isPending(id)).toBe(true);
    expect(manager.getPendingCount()).toBe(1);

    // Resolve the request
    const resolved = manager.resolve(id, { success: true });
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result).toEqual({ success: true });

    expect(manager.isPending(id)).toBe(false);
    expect(manager.getPendingCount()).toBe(0);
  });

  test("should timeout requests after specified duration", async () => {
    const id = manager.generateId("test");
    const promise = manager.register<{ success: boolean; error?: string }>(
      id,
      "test",
      1000,
      (_id, _type, timeoutMs) => ({ success: false, error: `Timeout after ${timeoutMs}ms` }),
    );

    expect(manager.isPending(id)).toBe(true);

    // Advance time past the timeout
    fakeTimer.advanceTime(1000);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout after 1000ms");

    expect(manager.isPending(id)).toBe(false);
  });

  test("should cancel timeout when request is resolved", async () => {
    const id = manager.generateId("test");
    const promise = manager.register<{ success: boolean }>(id, "test", 5000, () => ({
      success: false,
    }));

    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    // Resolve the request
    manager.resolve(id, { success: true });

    // Timeout should be cancelled
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);

    const result = await promise;
    expect(result.success).toBe(true);
  });

  test("should handle multiple concurrent requests of same type", async () => {
    const id1 = manager.generateId("screenshot");
    const id2 = manager.generateId("screenshot");
    const id3 = manager.generateId("screenshot");

    const promise1 = manager.register<{ id: string }>(id1, "screenshot", 5000, () => ({
      id: "timeout",
    }));
    const promise2 = manager.register<{ id: string }>(id2, "screenshot", 5000, () => ({
      id: "timeout",
    }));
    const promise3 = manager.register<{ id: string }>(id3, "screenshot", 5000, () => ({
      id: "timeout",
    }));

    expect(manager.getPendingCount()).toBe(3);

    // Resolve in different order
    manager.resolve(id2, { id: "second" });
    manager.resolve(id3, { id: "third" });
    manager.resolve(id1, { id: "first" });

    const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

    expect(result1.id).toBe("first");
    expect(result2.id).toBe("second");
    expect(result3.id).toBe("third");
  });

  test("should return false when resolving unknown request ID", () => {
    const resolved = manager.resolve("unknown-id", { success: true });
    expect(resolved).toBe(false);
  });

  test("should reject requests", async () => {
    const id = manager.generateId("test");
    const promise = manager.register<{ success: boolean }>(id, "test", 5000, () => ({
      success: false,
    }));

    const rejected = manager.reject(id, new Error("Test error"));
    expect(rejected).toBe(true);

    await expect(promise).rejects.toThrow("Test error");
    expect(manager.isPending(id)).toBe(false);
  });

  test("should cancel all pending requests", async () => {
    const id1 = manager.generateId("test1");
    const id2 = manager.generateId("test2");

    const promise1 = manager.register<{ success: boolean }>(id1, "test1", 5000, () => ({
      success: false,
    }));
    const promise2 = manager.register<{ success: boolean }>(id2, "test2", 5000, () => ({
      success: false,
    }));

    expect(manager.getPendingCount()).toBe(2);

    manager.cancelAll(new Error("Connection closed"));

    expect(manager.getPendingCount()).toBe(0);

    await expect(promise1).rejects.toThrow("Connection closed");
    await expect(promise2).rejects.toThrow("Connection closed");
  });

  test("should return pending IDs for debugging", () => {
    const id1 = manager.generateId("test1");
    const id2 = manager.generateId("test2");

    manager.register(id1, "test1", 5000, () => ({}));
    manager.register(id2, "test2", 5000, () => ({}));

    const pendingIds = manager.getPendingIds();
    expect(pendingIds).toContain(id1);
    expect(pendingIds).toContain(id2);
    expect(pendingIds.length).toBe(2);
  });

  test("resolveError uses the request-specific error factory to shape the result", async () => {
    const id = manager.generateId("ios");
    const promise = manager.register<{ success: boolean; wireText?: string; totalTimeMs?: number }>(
      id,
      "ios",
      5000,
      () => ({ success: false }),
      (error, totalTimeMs) => ({ success: false, wireText: error, totalTimeMs }),
    );

    const handled = manager.resolveError(id, "unknown command: frobnicate", 42);
    expect(handled).toBe(true);

    const result = await promise;
    // The iOS unknown-command wire text must survive as its typed field, not be
    // flattened into the generic envelope's `error`.
    expect(result.success).toBe(false);
    expect(result.wireText).toBe("unknown command: frobnicate");
    expect(result.totalTimeMs).toBe(42);
  });

  test("resolveError defaults totalTimeMs to 0 and still routes through the factory", async () => {
    const id = manager.generateId("ios");
    const promise = manager.register<{ success: boolean; wireText?: string; totalTimeMs?: number }>(
      id,
      "ios",
      5000,
      () => ({ success: false }),
      (error, totalTimeMs) => ({ success: false, wireText: error, totalTimeMs }),
    );

    manager.resolveError(id, "late reply");

    const result = await promise;
    expect(result.wireText).toBe("late reply");
    expect(result.totalTimeMs).toBe(0);
  });

  test("resolveError falls back to a generic envelope when no factory is registered", async () => {
    const id = manager.generateId("swipe");
    const promise = manager.register<{ success: boolean; error?: string; totalTimeMs?: number }>(
      id,
      "swipe",
      5000,
      () => ({ success: false }),
    );

    manager.resolveError(id, "device offline", 7);

    const result = await promise;
    expect(result).toEqual({ success: false, totalTimeMs: 7, error: "device offline" });
  });

  test("resolveError clears the pending timeout and removes the request", () => {
    const id = manager.generateId("test");
    manager.register(
      id,
      "test",
      5000,
      () => ({}),
      (error, totalTimeMs) => ({ error, totalTimeMs }),
    );

    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    manager.resolveError(id, "boom", 0);

    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(manager.isPending(id)).toBe(false);
  });

  test("resolveError returns false for an unknown request id", () => {
    expect(manager.resolveError("does-not-exist", "boom", 0)).toBe(false);
  });

  test("resets the counter on reset so the next id restarts from 1", () => {
    manager.generateId("test");
    manager.generateId("test");
    manager.generateId("test");

    manager.reset();

    // FakeTimer stays at now()=0, so the next id is fully determined: the counter
    // must restart at 1 rather than continue from 4.
    const newId = manager.generateId("test");
    expect(newId).toBe("test_0_1");
  });
});
