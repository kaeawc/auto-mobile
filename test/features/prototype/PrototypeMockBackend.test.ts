import { describe, expect, test } from "bun:test";
import { PrototypeMockBackend } from "../../../src/features/prototype/PrototypeMockBackend";
import type { MockBackendDefinition } from "../../../src/features/prototype/prototypeMockSchema";
import type { PrototypeRequestJson } from "../../../src/features/prototype/prototypeRequestProtocol";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SeededRandom } from "../../fakes/SeededRandom";
import fixture from "../../fixtures/prototype-mock/requests.json";

class RecordingTimer extends FakeTimer {
  readonly sleeps: number[] = [];
  override async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }
}

function backend(definition: MockBackendDefinition, seed = 1) {
  const timer = new RecordingTimer();
  return {
    timer,
    engine: new PrototypeMockBackend(definition, {
      random: new SeededRandom(seed),
      ids: new FakeIdGenerator(),
      timer,
    }),
  };
}

function split(path: string): { path: string; query: Record<string, string> } {
  const url = new URL(path, "https://x.test");
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

interface Step {
  method: string;
  path: string;
  status: number;
  body?: PrototypeRequestJson;
  expect?: PrototypeRequestJson;
  headers?: Record<string, string>;
}

describe("PrototypeMockBackend fixtures", () => {
  test.each(fixture.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_name, entry) => {
      const { engine } = backend(entry.definition as MockBackendDefinition);
      for (const step of entry.steps as Step[]) {
        const response = await engine.answer({
          method: step.method,
          ...split(step.path),
          body: step.body,
        });
        expect({ at: `${step.method} ${step.path}`, status: response.status }).toEqual({
          at: `${step.method} ${step.path}`,
          status: step.status,
        });
        if (step.expect !== undefined) {
          expect(response.body).toEqual(step.expect);
        }
        for (const [name, value] of Object.entries(step.headers ?? {})) {
          expect(response.headers[name]).toBe(value);
        }
      }
    },
  );
});

describe("PrototypeMockBackend", () => {
  test("a definition is copied, so a later write does not change the caller's data", async () => {
    const items = [{ id: 1, n: 1 }];
    const { engine } = backend({ collections: { posts: items } });
    await engine.answer({ method: "PATCH", path: "/posts/1", query: {}, body: { n: 2 } });
    expect(items).toEqual([{ id: 1, n: 1 }]);
    expect(engine.snapshot()).toEqual({ posts: [{ id: 1, n: 2 }] });
  });

  test("latency draws from the seeded stream and sleeps on the injected timer", async () => {
    const draw = (seed: number) => {
      const random = new SeededRandom(seed);
      return Math.floor(random.next() * 101) + 100;
    };
    const first = backend(
      { latencyMs: { min: 100, max: 200 }, routes: [{ method: "GET", path: "/x" }] },
      7,
    );
    await first.engine.answer({ method: "GET", path: "/x", query: {}, body: undefined });
    await first.engine.answer({ method: "GET", path: "/x", query: {}, body: undefined });
    expect(first.timer.sleeps[0]).toBe(draw(7));
    const again = backend(
      { latencyMs: { min: 100, max: 200 }, routes: [{ method: "GET", path: "/x" }] },
      7,
    );
    await again.engine.answer({ method: "GET", path: "/x", query: {}, body: undefined });
    await again.engine.answer({ method: "GET", path: "/x", query: {}, body: undefined });
    expect(again.timer.sleeps).toEqual(first.timer.sleeps);
    expect(first.timer.sleeps.every((ms) => ms >= 100 && ms <= 200)).toBe(true);
  });

  test("no latency means no sleep, and a zero draw does not sleep", async () => {
    const none = backend({ routes: [{ method: "GET", path: "/x" }] });
    await none.engine.answer({ method: "GET", path: "/x", query: {}, body: undefined });
    const zero = backend({
      latencyMs: { min: 0, max: 0 },
      routes: [{ method: "GET", path: "/x" }],
    });
    await zero.engine.answer({ method: "GET", path: "/x", query: {}, body: undefined });
    expect([...none.timer.sleeps, ...zero.timer.sleeps]).toEqual([]);
  });

  test("a route delay sleeps in addition to latency", async () => {
    const { engine, timer } = backend({ routes: [{ method: "GET", path: "/slow", delayMs: 250 }] });
    await engine.answer({ method: "GET", path: "/slow", query: {}, body: undefined });
    expect(timer.sleeps).toEqual([250]);
  });

  test("rate faults replay identically for the same seed and differ across seeds", async () => {
    const run = async (seed: number) => {
      const { engine } = backend(
        {
          routes: [{ method: "GET", path: "/x" }],
          faults: [{ path: "/x", status: 500, rate: 0.5 }],
        },
        seed,
      );
      const statuses: number[] = [];
      for (let i = 0; i < 20; i++) {
        statuses.push(
          (await engine.answer({ method: "GET", path: "/x", query: {}, body: undefined })).status,
        );
      }
      return statuses;
    };
    const a = await run(3);
    expect(await run(3)).toEqual(a);
    expect(a).toContain(500);
    expect(a).toContain(200);
    expect(await run(4)).not.toEqual(a);
  });

  test("a fault matches by method and path pattern only", async () => {
    const { engine } = backend({
      routes: [
        { method: "GET", path: "/a/:id" },
        { method: "POST", path: "/a/:id" },
      ],
      faults: [{ path: "/a/:id", method: "POST", status: 502, every: 1 }],
    });
    const get = await engine.answer({ method: "GET", path: "/a/1", query: {}, body: undefined });
    const post = await engine.answer({ method: "POST", path: "/a/1", query: {}, body: undefined });
    expect([get.status, post.status]).toEqual([200, 502]);
  });

  test("the request log records each answered request with a sequence number", async () => {
    const { engine } = backend({ collections: { posts: [{ id: 1 }] } });
    await engine.answer({ method: "get", path: "/posts", query: { a: "b" }, body: undefined });
    await engine.answer({ method: "POST", path: "/posts", query: {}, body: { x: 1 } });
    expect(engine.requestLog()).toEqual([
      { seq: 1, method: "GET", path: "/posts", query: { a: "b" }, status: 200 },
      { seq: 2, method: "POST", path: "/posts", query: {}, status: 201, body: { x: 1 } },
    ]);
    expect(engine.requestLog(1).map((entry) => entry.seq)).toEqual([2]);
  });

  test("the request log keeps only the latest 200 entries", async () => {
    const { engine } = backend({ routes: [{ method: "GET", path: "/x" }] });
    for (let i = 0; i < 205; i++) {
      await engine.answer({ method: "GET", path: "/x", query: {}, body: undefined });
    }
    const log = engine.requestLog();
    expect([log.length, log[0]!.seq, log[199]!.seq]).toEqual([200, 6, 205]);
  });

  test("a write that would exceed the collection size budget is refused and leaves it unchanged", async () => {
    const { engine } = backend({ collections: { blobs: [] } });
    const big = { text: "x".repeat(600 * 1024) };
    expect(
      (await engine.answer({ method: "POST", path: "/blobs", query: {}, body: big })).status,
    ).toBe(201);
    const refused = await engine.answer({ method: "POST", path: "/blobs", query: {}, body: big });
    expect(refused.status).toBe(413);
    expect(engine.snapshot().blobs).toHaveLength(1);
  });

  test("ids and collection names are compared percent-decoded", async () => {
    const { engine } = backend({
      collections: {
        "my-items": [
          { id: "a b", n: 1 },
          { id: "€", n: 2 },
        ],
      },
    });
    const call = (method: string, path: string, body?: PrototypeRequestJson) =>
      engine.answer({ method, path, query: {}, body });
    expect((await call("GET", "/my-items/a%20b")).body).toEqual({ id: "a b", n: 1 });
    expect((await call("GET", "/my-items/%E2%82%AC")).body).toEqual({ id: "€", n: 2 });
    expect((await call("PATCH", "/my-items/a%20b", { n: 9 })).status).toBe(200);
    expect((await call("DELETE", "/my-items/%E2%82%AC")).status).toBe(200);
    expect(engine.snapshot()).toEqual({ "my-items": [{ id: "a b", n: 9 }] });
    expect((await call("GET", "/my%2Ditems")).status).toBe(200);
  });

  test("the size budget covers every collection and the canned routes together", async () => {
    const big = { text: "x".repeat(600 * 1024) };
    const two = backend({ collections: { a: [], b: [] } }).engine;
    expect((await two.answer({ method: "POST", path: "/a", query: {}, body: big })).status).toBe(
      201,
    );
    expect((await two.answer({ method: "POST", path: "/b", query: {}, body: big })).status).toBe(
      413,
    );
    expect(two.snapshot().b).toEqual([]);

    const withRoute = backend({
      collections: { a: [] },
      routes: [{ method: "GET", path: "/r", body: "y".repeat(700 * 1024) }],
    }).engine;
    expect(
      (await withRoute.answer({ method: "POST", path: "/a", query: {}, body: big })).status,
    ).toBe(413);
    const small = { text: "x".repeat(200 * 1024) };
    expect(
      (await withRoute.answer({ method: "POST", path: "/a", query: {}, body: small })).status,
    ).toBe(201);
  });
});

describe("PrototypeMockBackend rooms and broadcasts", () => {
  const chat: MockBackendDefinition = {
    collections: { messages: [] },
    rooms: [{ path: "/rooms/:roomId", relay: true }],
    broadcasts: {
      messages: { room: "/rooms/{item:/roomId}", frame: { type: "message", message: "{item}" } },
    },
  };

  function member(engine: PrototypeMockBackend, path: string): string[] {
    const frames: string[] = [];
    const joined = engine.join(path, {}, { deliver: (data) => frames.push(data), close: () => {} });
    expect(joined.ok).toBe(true);
    return frames;
  }

  test("a POST to a broadcasting collection reaches the room the stored item names", async () => {
    const { engine } = backend(chat);
    const general = member(engine, "/rooms/general");
    const other = member(engine, "/rooms/other");
    const response = await engine.answer({
      method: "POST",
      path: "/messages",
      query: {},
      body: { roomId: "general", text: "hi" },
    });
    expect(response.status).toBe(201);
    expect(general.map((data) => JSON.parse(data))).toEqual([
      { type: "message", message: response.body },
    ]);
    expect(other).toEqual([]);
    expect(
      engine.requestLog().map((entry) => ("room" in entry ? entry.from : entry.method)),
    ).toEqual(["POST", "broadcast"]);
  });

  test("only the configured write methods with a 2xx answer broadcast", async () => {
    const { engine } = backend({
      ...chat,
      collections: { messages: [{ id: 1, roomId: "general" }] },
      faults: [{ path: "/messages", method: "POST", status: 500, every: 1 }],
    });
    const general = member(engine, "/rooms/general");
    await engine.answer({
      method: "POST",
      path: "/messages",
      query: {},
      body: { roomId: "general" },
    });
    await engine.answer({ method: "PATCH", path: "/messages/1", query: {}, body: { text: "x" } });
    await engine.answer({ method: "DELETE", path: "/messages/1", query: {}, body: undefined });
    expect(general).toEqual([]);
  });

  test("on selects PATCH, and a route body's literal {item} text is not bound", async () => {
    const { engine } = backend({
      ...chat,
      collections: { messages: [{ id: 1, roomId: "general" }] },
      routes: [{ method: "GET", path: "/literal", body: "{item}" }],
      broadcasts: {
        messages: { room: "/rooms/{item:/roomId}", frame: "{item:/text}", on: ["PATCH"] },
      },
    });
    const general = member(engine, "/rooms/general");
    await engine.answer({
      method: "PATCH",
      path: "/messages/1",
      query: {},
      body: { text: "edited" },
    });
    expect(general).toEqual(["edited"]);
    expect(
      (await engine.answer({ method: "GET", path: "/literal", query: {}, body: undefined })).body,
    ).toBe("{item}");
  });

  test("publish speaks to a room and dispose closes its connections", () => {
    const { engine } = backend(chat);
    const closes: number[] = [];
    const frames: string[] = [];
    engine.join(
      "/rooms/a",
      {},
      { deliver: (data) => frames.push(data), close: (code) => closes.push(code) },
    );
    expect(engine.publish("/rooms/a", { hello: true })).toBe(1);
    engine.dispose("bye");
    expect([frames, closes]).toEqual([['{"hello":true}'], [1001]]);
    expect(engine.roomCount).toBe(1);
  });
});
