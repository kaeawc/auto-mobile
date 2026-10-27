import { expect, spyOn, test } from "bun:test";
import { DaemonHttpTokenLifecycle } from "../../src/daemon/daemonCore/DaemonHttpTokenLifecycle";
import { FakeDaemonHttpTokenStore } from "../../src/daemon/daemonHttpToken";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

test("an unpublished daemon clears its configured credential without removing another daemon's file", () => {
  const store = new FakeDaemonHttpTokenStore();
  store.write("other-daemon");
  const lifecycle = new DaemonHttpTokenLifecycle(store, new CountingIdGenerator(), "configured");
  lifecycle.remove();
  expect(lifecycle.value).toBe("");
  expect(store.read()).toBe("other-daemon");
});

test("preparation configures ingress without publishing and a failed publication leaves stale content", () => {
  const store = new FakeDaemonHttpTokenStore();
  store.write("stale");
  const lifecycle = new DaemonHttpTokenLifecycle(store, new CountingIdGenerator());
  lifecycle.prepare();
  expect(lifecycle.value).toBe("id-1");
  expect(store.read()).toBe("stale");
  const write = spyOn(store, "write").mockImplementation(() => {
    expect(lifecycle.value).toBe("id-1");
    throw new Error("Publication failed");
  });
  try {
    expect(() => lifecycle.publish()).toThrow("Publication failed");
    expect(lifecycle.value).toBe("id-1");
    lifecycle.remove();
    expect(store.read()).toBe("stale");
  } finally {
    write.mockRestore();
  }
});

test("shutdown relinquishes publication ownership and a subsequent publication rotates the credential", () => {
  const store = new FakeDaemonHttpTokenStore();
  const lifecycle = new DaemonHttpTokenLifecycle(store, new CountingIdGenerator());
  lifecycle.prepare();
  lifecycle.publish();
  const first = lifecycle.value;
  expect(store.read()).toBe(first);
  lifecycle.remove();
  expect(store.read()).toBeUndefined();
  expect(lifecycle.value).toBe("");
  store.write("successor");
  lifecycle.remove();
  expect(store.read()).toBe("successor");
  lifecycle.prepare();
  lifecycle.publish();
  expect(lifecycle.value).not.toBe(first);
  expect(store.read()).toBe(lifecycle.value);
  lifecycle.remove();
  expect(store.read()).toBeUndefined();
});

test("shutdown preserves a replacement token after this daemon published", () => {
  const store = new FakeDaemonHttpTokenStore();
  const lifecycle = new DaemonHttpTokenLifecycle(store, new CountingIdGenerator());
  lifecycle.prepare();
  lifecycle.publish();
  store.token = "successor";
  lifecycle.remove();
  expect(store.read()).toBe("successor");
  expect(lifecycle.value).toBe("");
});

test("publication without a configured token is refused", () => {
  const store = new FakeDaemonHttpTokenStore();
  const lifecycle = new DaemonHttpTokenLifecycle(store, undefined);
  expect(() => lifecycle.publish()).toThrow("Daemon HTTP token is not configured");
  expect(store.read()).toBeUndefined();
});
