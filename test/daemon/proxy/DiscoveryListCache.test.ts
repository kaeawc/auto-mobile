import { describe, expect, test } from "bun:test";
import {
  DiscoveryListCache,
  type DiscoveryListCachePort,
} from "../../../src/daemon/proxy/DiscoveryListCache";

type Call = { method: string; params: Record<string, unknown> };

function makeCache(respond: (call: Call) => Promise<any> | any) {
  const calls: Call[] = [];
  const observed: Array<{ kind: string; list: unknown }> = [];
  const reconnects: Array<{ session: string | undefined; released: boolean | undefined }> = [];
  const port: DiscoveryListCachePort = {
    boundParams: (released) => (released ? {} : { sessionUuid: "bound" }),
    withToolSelectionProfile: (args) => ({ ...args, profile: "p" }),
    sessionUuidFromArgs: (args) => args.sessionUuid as string | undefined,
    callDaemonMethod: async (method, params) => {
      const call = { method, params };
      calls.push(call);
      return respond(call);
    },
    observeList: (kind, list) => observed.push({ kind, list }),
  };
  const cache = new DiscoveryListCache({
    recovery: {
      withRecoverableReconnect: async (operation, session, released) => {
        reconnects.push({ session, released });
        return operation();
      },
    },
    port,
  });
  return { cache, calls, observed, reconnects };
}

const tool = { name: "t", inputSchema: {} };

describe("DiscoveryListCache", () => {
  test("fetchTools forwards session-scoped params once and serves the cache", async () => {
    const { cache, calls, observed, reconnects } = makeCache(() => ({ tools: [tool] }));
    expect(await cache.fetchTools(false)).toEqual([tool]);
    expect(await cache.fetchTools(false)).toEqual([tool]);
    expect(calls).toEqual([
      { method: "tools/list", params: { sessionUuid: "bound", profile: "p" } },
    ]);
    expect(reconnects).toEqual([{ session: "bound", released: false }]);
    expect(observed).toEqual([{ kind: "tools", list: [tool] }]);
  });

  test("an unbound list after a result-minted release is returned but not cached", async () => {
    const { cache, calls } = makeCache(() => ({ resources: [{ uri: "u", name: "n" }] }));
    expect(await cache.fetchResources(true)).toHaveLength(1);
    expect(cache.resources).toBeNull();
    await cache.fetchResources(true);
    expect(calls.map((c) => c.params)).toEqual([{}, {}]);
  });

  test("a response invalidated mid-flight does not repopulate the cache", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { cache, observed } = makeCache(async () => {
      await gate;
      return { resourceTemplates: [{ uriTemplate: "x", name: "n" }] };
    });
    const pending = cache.fetchResourceTemplates(false);
    cache.invalidateKind("resources");
    release();
    expect(await pending).toHaveLength(1);
    expect(cache.resourceTemplates).toBeNull();
    expect(observed).toEqual([]);
  });

  test("invalidateKind clears only the matching kind and bumps the epoch", async () => {
    const { cache } = makeCache((call) =>
      call.method === "tools/list" ? { tools: [tool] } : { resources: [], resourceTemplates: [] },
    );
    await cache.fetchTools(false);
    await cache.fetchResources(false);
    await cache.fetchResourceTemplates(false);
    cache.invalidateKind("tools");
    expect(cache.tools).toBeNull();
    expect(cache.resources).not.toBeNull();
    expect(cache.epoch).toBe(1);
    cache.invalidateKind("resources");
    expect(cache.resources).toBeNull();
    expect(cache.resourceTemplates).toBeNull();
    expect(cache.epoch).toBe(2);
  });

  test("invalidateAll clears everything without bumping the epoch", async () => {
    const { cache } = makeCache(() => ({ tools: [tool], resources: [], resourceTemplates: [] }));
    await cache.fetchTools(false);
    await cache.fetchResources(false);
    cache.invalidateAll();
    expect([cache.tools, cache.resources, cache.resourceTemplates]).toEqual([null, null, null]);
    expect(cache.epoch).toBe(0);
  });

  test("a failed fetch rethrows and caches nothing", async () => {
    const { cache } = makeCache(() => {
      throw new Error("boom");
    });
    await expect(cache.fetchTools(false)).rejects.toThrow("boom");
    expect(cache.tools).toBeNull();
  });
});
