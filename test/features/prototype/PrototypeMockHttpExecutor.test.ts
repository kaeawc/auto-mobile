import { describe, expect, test } from "bun:test";
import type {
  PrototypeHttpExecutor,
  PrototypeHttpOutcome,
  PrototypeHttpRequest,
} from "../../../src/features/prototype/PrototypeHttpExecutor";
import { FetchPrototypeHttpExecutor } from "../../../src/features/prototype/PrototypeHttpExecutor";
import { PrototypeMockBackendRegistry } from "../../../src/features/prototype/PrototypeMockBackendRegistry";
import { MockRoutingPrototypeHttpExecutor } from "../../../src/features/prototype/PrototypeMockHttpExecutor";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

class RecordingExecutor implements PrototypeHttpExecutor {
  calls: PrototypeHttpRequest[] = [];
  async execute(request: PrototypeHttpRequest): Promise<PrototypeHttpOutcome> {
    this.calls.push(request);
    return { ok: true, status: 204, headers: {}, body: null, durationMs: 0 };
  }
}

function setup() {
  const timer = new FakeTimer();
  const registry = new PrototypeMockBackendRegistry({ ids: new FakeIdGenerator(), timer });
  const inner = new RecordingExecutor();
  return {
    registry,
    inner,
    executor: new MockRoutingPrototypeHttpExecutor(inner, registry, timer),
  };
}

const signal = () => new AbortController().signal;

describe("MockRoutingPrototypeHttpExecutor", () => {
  test("answers a reserved-origin request from the backend without touching the inner executor", async () => {
    const { registry, inner, executor } = setup();
    registry.define("shop", { collections: { items: [{ id: 1, name: "a" }] } });
    const outcome = await executor.execute(
      { method: "GET", url: "https://shop.mock.automobile.invalid/items?name=a" },
      signal(),
    );
    expect(outcome).toEqual({
      ok: true,
      status: 200,
      headers: {},
      body: [{ id: 1, name: "a" }],
      durationMs: 0,
    });
    expect(inner.calls).toEqual([]);
  });

  test("passes ordinary destinations to the inner executor", async () => {
    const { inner, executor } = setup();
    const request: PrototypeHttpRequest = { method: "GET", url: "https://example.com/x" };
    await executor.execute(request, signal());
    expect(inner.calls).toEqual([request]);
  });

  test("a mock request performs no DNS lookup and no fetch, even through the real executor", async () => {
    const timer = new FakeTimer();
    const registry = new PrototypeMockBackendRegistry({ ids: new FakeIdGenerator(), timer });
    registry.define("shop", { routes: [{ method: "GET", path: "/ping", body: "pong" }] });
    const lookups: string[] = [];
    let fetches = 0;
    const real = new FetchPrototypeHttpExecutor({
      timer,
      resolver: async (hostname) => {
        lookups.push(hostname);
        return [{ address: "8.8.8.8", family: 4 }];
      },
      fetch: async () => {
        fetches++;
        return new Response("{}");
      },
    });
    const executor = new MockRoutingPrototypeHttpExecutor(real, registry, timer);
    const outcome = await executor.execute(
      { method: "GET", url: "https://shop.mock.automobile.invalid/ping" },
      signal(),
    );
    expect(outcome).toMatchObject({ ok: true, body: "pong" });
    expect([lookups, fetches]).toEqual([[], 0]);
  });

  test("an unknown or invalid backend fails as network without a lookup", async () => {
    const { inner, executor } = setup();
    for (const [url, id] of [
      ["https://nobody.mock.automobile.invalid/x", "nobody"],
      ["https://a.b.mock.automobile.invalid/x", "a.b"],
    ] as const) {
      const outcome = await executor.execute({ method: "GET", url }, signal());
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "network", message: `No mock backend "${id}" is defined.` },
      });
    }
    expect(inner.calls).toEqual([]);
  });

  test("a JSON text body is parsed for the engine, and a non-JSON string is not an object body", async () => {
    const { registry, executor } = setup();
    registry.define("shop", { collections: { items: [] } });
    const url = "https://shop.mock.automobile.invalid/items";
    const created = await executor.execute({ method: "POST", url, body: '{"name":"x"}' }, signal());
    expect(created).toMatchObject({ ok: true, status: 201 });
    const bad = await executor.execute({ method: "POST", url, body: "plain text" }, signal());
    expect(bad).toMatchObject({ ok: true, status: 400 });
  });

  test("a HEAD request answers with no body", async () => {
    const { registry, executor } = setup();
    registry.define("shop", { routes: [{ method: "GET", path: "/x", body: "y" }] });
    const outcome = await executor.execute(
      { method: "HEAD", url: "https://shop.mock.automobile.invalid/x" },
      signal(),
    );
    expect(outcome).toMatchObject({ ok: true, status: 404, body: null });
  });

  test("a cancelled request is cancelled before and after the backend answers", async () => {
    const { registry, executor } = setup();
    registry.define("shop", { routes: [{ method: "GET", path: "/x", body: "y" }] });
    const url = "https://shop.mock.automobile.invalid/x";
    const before = new AbortController();
    before.abort();
    expect(await executor.execute({ method: "GET", url }, before.signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    const during = new AbortController();
    registry.define("slow", { routes: [{ method: "GET", path: "/x", body: "y" }] });
    const pending = executor.execute({ method: "GET", url }, during.signal);
    during.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  test("a response above the response cap is too_large", async () => {
    const { registry, executor } = setup();
    registry.define("shop", { collections: { blobs: [{ id: 1, t: "x".repeat(900 * 1024) }] } });
    const outcome = await executor.execute(
      { method: "GET", url: "https://shop.mock.automobile.invalid/blobs" },
      signal(),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "too_large" } });
  });
});
