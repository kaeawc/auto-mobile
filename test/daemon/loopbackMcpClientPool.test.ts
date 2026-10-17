import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  MCP_CLIENT_IDLE_CLOSE_MS,
  clearPooledIdleTimer,
  closePooledClient,
  discardTimedOutReconnect,
  getPooledClient,
  resetPooledClient,
  resetPooledClientIfCurrent,
  runWithActivePooledClient,
  schedulePooledIdleClose,
  type LoopbackClientPool,
} from "../../src/daemon/socketServer/loopbackMcpClientPool";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

/** #11815: the loopback MCP client cache, with its state and hooks injected. */
interface FakeClient {
  client: Client;
  closed: number;
}

function fakeClient(): FakeClient {
  const fake: FakeClient = {
    closed: 0,
    // An untyped prototype object stands in for the SDK client: only `close` is exercised.
    client: Object.assign(Object.create(Client.prototype), {
      close: async () => {
        fake.closed++;
      },
    }),
  };
  return fake;
}

function fixture() {
  const timer = new FakeTimer();
  const created: FakeClient[] = [];
  const idle: string[] = [];
  let closing = false;
  let generation = 0;
  const pool: LoopbackClientPool = {
    clients: new Map(),
    promises: new Map(),
    idleTimers: new Map(),
    activeForwardCounts: new Map(),
    timer,
    factory: () => async () => {
      const fake = fakeClient();
      created.push(fake);
      return fake.client;
    },
    generation: () => generation,
    isSuperseded: (since) => closing || since !== generation,
    closeClient: (key, client) => closePooledClient(timer, key, client),
    clearIdleTimer: (key) => clearPooledIdleTimer(pool, key),
    scheduleIdleClose: (key) => schedulePooledIdleClose(pool, key),
    resetClient: (key, mode) => resetPooledClient(pool, key, mode),
    resetClientIfCurrent: (key, client, mode) =>
      resetPooledClientIfCurrent(pool, key, client, mode),
    onIdle: async (key) => {
      idle.push(key);
    },
  };
  return {
    pool,
    timer,
    created,
    idle,
    close: () => {
      closing = true;
    },
    bump: () => {
      generation++;
    },
  };
}

describe("loopback MCP client pool", () => {
  test("concurrent requests for one key share one client, which is then cached", async () => {
    const { pool, created } = fixture();
    const [a, b] = await Promise.all([getPooledClient(pool, "k"), getPooledClient(pool, "k")]);
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
    expect(await getPooledClient(pool, "k")).toBe(a);
    expect(pool.promises.size).toBe(0);
  });

  test("a creation superseded by close is closed and rejects, never cached", async () => {
    const { pool, created, close } = fixture();
    const pending = getPooledClient(pool, "k");
    close();
    await expect(pending).rejects.toThrow("MCP client creation was superseded");
    expect(created[0].closed).toBe(1);
    expect(pool.clients.size).toBe(0);
  });

  test("a creation superseded by a lifecycle change is closed and rejects", async () => {
    const { pool, created, bump } = fixture();
    const pending = getPooledClient(pool, "k");
    bump();
    await expect(pending).rejects.toThrow("superseded");
    expect(created[0].closed).toBe(1);
  });

  test("the idle timer fires after the idle window and is cleared by use", async () => {
    const { pool, timer, idle } = fixture();
    schedulePooledIdleClose(pool, "k");
    timer.advanceTime(MCP_CLIENT_IDLE_CLOSE_MS - 1);
    expect(idle).toEqual([]);
    await getPooledClient(pool, "k");
    timer.advanceTime(10);
    expect(idle).toEqual([]);
    schedulePooledIdleClose(pool, "k");
    timer.advanceTime(MCP_CLIENT_IDLE_CLOSE_MS);
    expect(idle).toEqual(["k"]);
  });

  test("active forwards are counted and the idle close re-arms when the last one ends", async () => {
    const { pool, timer, idle } = fixture();
    const gate = Promise.withResolvers<void>();
    const first = runWithActivePooledClient(pool, "k", () => gate.promise);
    const second = runWithActivePooledClient(pool, "k", async () => {
      throw new Error("early failure");
    });
    await expect(second).rejects.toThrow("early failure");
    expect(pool.activeForwardCounts.get("k")).toBe(1);
    expect(pool.idleTimers.size).toBe(0);
    gate.resolve();
    await first;
    expect(pool.activeForwardCounts.size).toBe(0);
    timer.advanceTime(MCP_CLIENT_IDLE_CLOSE_MS);
    expect(idle).toEqual(["k"]);
  });

  test("reset closes and forgets the client; if-current never closes a replacement", async () => {
    const { pool, created } = fixture();
    const first = await getPooledClient(pool, "k");
    await resetPooledClient(pool, "k");
    expect(created[0].closed).toBe(1);
    expect(pool.clients.size).toBe(0);
    const second = await getPooledClient(pool, "k");
    expect(await resetPooledClientIfCurrent(pool, "k", first)).toBe(false);
    expect(created[1].closed).toBe(0);
    expect(await resetPooledClientIfCurrent(pool, "k", second)).toBe(true);
    expect(created[1].closed).toBe(1);
  });

  test("a timed-out reconnect drops its pending creation and closes only its own client", async () => {
    const { pool, created } = fixture();
    const connection = getPooledClient(pool, "k");
    discardTimedOutReconnect(pool, "k", connection, pool.promises.get("k"));
    expect(pool.promises.size).toBe(0);
    await expect(connection).rejects.toThrow("superseded");
    await drainMicrotasks(20);
    expect(created[0].closed).toBe(1);
  });
});
