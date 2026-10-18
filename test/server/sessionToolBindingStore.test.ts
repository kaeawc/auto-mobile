import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
} from "../../src/server/directSessionDeviceRegistry";
import { executionTracker } from "../../src/server/executionTracker";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";
import { SessionToolBindingStore } from "../../src/server/sessionToolBindingStore";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

/** A store whose release subscription the test drives by hand. */
function fakeReleaseStore() {
  const handlers: Array<(sessionUuid: string) => void> = [];
  let subscriptions = 0;
  let changes = 0;
  const store = new SessionToolBindingStore({
    subscribeReleases: (onReleased) => {
      subscriptions += 1;
      handlers.push(onReleased);
      return () => {
        handlers.splice(handlers.indexOf(onReleased), 1);
      };
    },
    onBindingChanged: () => {
      changes += 1;
    },
  });
  return {
    store,
    release: (sessionUuid: string) => handlers.forEach((handler) => handler(sessionUuid)),
    subscriptions: () => subscriptions,
    changes: () => changes,
  };
}

const binding = (store: SessionToolBindingStore) =>
  new SessionToolBinding(undefined, undefined, undefined, undefined, undefined, store);

describe("SessionToolBindingStore", () => {
  test("two bindings on one store share a key's binding, but not the direct slot", () => {
    const store = new SessionToolBindingStore();
    const first = binding(store);
    const second = binding(store);

    expect(first.bind("key-1", "session-a")).toBe(true);
    expect(second.bind(undefined, "session-direct")).toBe(true);

    expect(second.effectiveSessionUuid("key-1")).toBe("session-a");
    expect(second.ownsSession("key-1", "session-a")).toBe(true);
    expect(second.effectiveSessionUuid("key-2")).toBeUndefined();
    expect(first.effectiveSessionUuid(undefined)).toBeUndefined();
    expect(second.effectiveSessionUuid(undefined)).toBe("session-direct");
  });

  test("subscribes once and reports a release exactly once across attached bindings", () => {
    const fake = fakeReleaseStore();
    const first = binding(fake.store);
    const second = new SessionToolBinding(
      "session-a",
      undefined,
      undefined,
      undefined,
      undefined,
      fake.store,
    );
    first.bind("key-1", "session-a");

    expect(fake.subscriptions()).toBe(1);
    fake.release("session-a");
    fake.release("session-a");

    expect(fake.changes()).toBe(1);
    expect(first.effectiveSessionUuid("key-1")).toBeUndefined();
    expect(first.releasedResourceSessionUuid("key-1")).toBe("session-a");
    expect(second.effectiveSessionUuid(undefined)).toBeUndefined();
  });

  test("a detached binding keeps no release teardown; the keyed binding still clears", () => {
    const fake = fakeReleaseStore();
    const detached = new SessionToolBinding(
      "session-a",
      undefined,
      undefined,
      undefined,
      undefined,
      fake.store,
    );
    const live = binding(fake.store);
    live.bind("key-1", "session-a");
    detached.dispose();

    fake.release("session-a");

    expect(live.effectiveSessionUuid("key-1")).toBeUndefined();
    expect(detached.effectiveSessionUuid(undefined)).toBe("session-a");
  });

  test("forget drops a key's bindings without releasing the session", () => {
    const store = new SessionToolBindingStore();
    const first = binding(store);
    first.bind("key-1", "session-a");
    first.bindToolSelectionProfile("key-1", "profile-p");

    store.forget("key-1");

    expect(first.effectiveSessionUuid("key-1")).toBeUndefined();
    expect(first.connectionToolSelectionProfileUuid("key-1")).toBeUndefined();
    expect(first.releasedResourceSessionUuid("key-1")).toBeUndefined();
  });
});

describe("createMcpServer session key (#4678)", () => {
  const fixtures: McpTestFixture[] = [];
  const schema = z.object({ sessionUuid: z.string().optional() });

  const serve = async (options: ConstructorParameters<typeof McpTestFixture>[0]) => {
    const fixture = new McpTestFixture({
      sessionToolSelectionService: {
        isEnabled: async (sessionUuid, toolName, declaredDefault) =>
          toolName === "hiddenOnSessionA" && sessionUuid === "session-a" ? false : declaredDefault,
      },
      ...options,
    });
    fixtures.push(fixture);
    await fixture.setup();
    return fixture;
  };
  const listedNames = async (fixture: McpTestFixture) =>
    (await fixture.client.listTools()).tools.map((tool) => tool.name);

  // The first server pays the one-time tool/resource registration; keep it out of the tests.
  beforeAll(async () => {
    const warm = new McpTestFixture();
    await warm.setup();
    await warm.teardown();
  });

  beforeEach(() => {
    ToolRegistry.clearTools();
    clearDirectSessionDevices();
    registerDirectSessionDevice("session-a", {
      deviceId: "emulator-5554",
      name: "Pixel_9_API_36",
      platform: "android",
    });
    ToolRegistry.register("bindingProbe", "bindingProbe", schema, async () => ({ success: true }));
    ToolRegistry.register("hiddenOnSessionA", "hiddenOnSessionA", schema, async () => ({
      success: true,
    }));
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await fixture.teardown();
    }
    ToolRegistry.clearTools();
    clearDirectSessionDevices();
  });

  test("a binding made under a key filters another server's argument-less tools/list for that key", async () => {
    const store = new SessionToolBindingStore();
    const binder = await serve({ requestMcpSessionId: "key-1", sessionToolBindingStore: store });
    await binder.client.callTool({ name: "bindingProbe", arguments: { sessionUuid: "session-a" } });

    const sameKey = await serve({ requestMcpSessionId: "key-1", sessionToolBindingStore: store });
    const otherKey = await serve({ requestMcpSessionId: "key-2", sessionToolBindingStore: store });

    expect(await listedNames(sameKey)).not.toContain("hiddenOnSessionA");
    expect(await listedNames(otherKey)).toContain("hiddenOnSessionA");
  });

  test("a release clears the shared binding once, for every server on the store", async () => {
    const fake = fakeReleaseStore();
    const binder = await serve({
      requestMcpSessionId: "key-1",
      sessionToolBindingStore: fake.store,
    });
    await binder.client.callTool({ name: "bindingProbe", arguments: { sessionUuid: "session-a" } });
    const sameKey = await serve({
      requestMcpSessionId: "key-1",
      sessionToolBindingStore: fake.store,
    });

    fake.release("session-a");
    fake.release("session-a");

    expect(fake.subscriptions()).toBe(1);
    expect(fake.changes()).toBe(1);
    expect(await listedNames(sameKey)).toContain("hiddenOnSessionA");
  });

  test("cancelling by the request's session key aborts that key's running call", async () => {
    let cancelled = -1;
    let aborted: boolean | undefined;
    ToolRegistry.register(
      "blocking",
      "blocking",
      z.object({}),
      async (_args, _progress, signal) => {
        cancelled = await executionTracker.cancelSessionExecutions(
          "key-cancel",
          "socket_disconnect",
        );
        aborted = signal?.aborted;
        return { success: true };
      },
    );
    const fixture = await serve({
      requestMcpSessionId: "key-cancel",
      sessionToolBindingStore: new SessionToolBindingStore(),
    });

    await fixture.client.callTool({ name: "blocking", arguments: {} });

    expect(cancelled).toBe(1);
    expect(aborted).toBe(true);
  });
});

// App-resource registration starts device discovery independently of deviceTools.
let restoreHermeticServer: () => void;
beforeAll(() => {
  restoreHermeticServer = installHermeticServerFixture();
});
afterAll(() => restoreHermeticServer());
