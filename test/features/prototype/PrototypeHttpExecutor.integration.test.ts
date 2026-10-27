import { permissivePrototypeEgressPolicy } from "../../fakes/FakePrototypeEgressPolicy";
import { afterAll, describe, expect, test } from "bun:test";
import { FetchPrototypeHttpExecutor } from "../../../src/features/prototype/PrototypeHttpExecutor";
import { SystemTimer, defaultTimer } from "../../../src/utils/SystemTimer";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/echo") {
      return Response.json({
        method: req.method,
        body: await req.json(),
        accept: req.headers.get("accept"),
      });
    }
    if (path === "/authority") {
      return Response.json({ host: req.headers.get("host") });
    }
    if (path === "/redirect") {
      return new Response(null, { status: 302, headers: { Location: "/text" } });
    }
    if (path === "/redirect-stream") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
        { status: 302, headers: { Location: "/text" } },
      );
    }
    if (path === "/text") {
      return new Response("hello");
    }
    if (path === "/gzip") {
      return new Response(Bun.gzipSync(new TextEncoder().encode('{"compressed":true}')), {
        headers: { "Content-Encoding": "gzip" },
      });
    }
    if (path === "/big") {
      return new Response(new Uint8Array(1024));
    }
    if (path === "/slow") {
      await defaultTimer.sleep(2_000);
      return new Response("late");
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}`;
const executor = (maxResponseBytes?: number) =>
  new FetchPrototypeHttpExecutor({
    timer: new SystemTimer(),
    maxResponseBytes,
    policy: permissivePrototypeEgressPolicy,
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
  });
const signal = () => new AbortController().signal;

describe("FetchPrototypeHttpExecutor against a local server", () => {
  test("pins the connection to the resolved IP while preserving the original authority", async () => {
    expect(
      await executor().execute(
        {
          method: "GET",
          url: `http://fixture.invalid:${server.port}/authority`,
        },
        signal(),
      ),
    ).toMatchObject({ ok: true, body: { host: `fixture.invalid:${server.port}` } });
  });

  test("follows a relative redirect through the pinned transport", async () => {
    expect(
      await executor().execute({ method: "GET", url: `${base}/redirect` }, signal()),
    ).toMatchObject({ ok: true, body: "hello" });
  });

  test("cancels a streaming redirect body before following the next hop", async () => {
    expect(
      await executor().execute({ method: "GET", url: `${base}/redirect-stream` }, signal()),
    ).toMatchObject({ ok: true, body: "hello" });
  });

  test("decodes compressed responses through the pinned transport", async () => {
    expect(
      await executor().execute({ method: "GET", url: `${base}/gzip` }, signal()),
    ).toMatchObject({ ok: true, body: { compressed: true } });
  });

  test("round-trips a JSON request", async () => {
    const outcome = await executor().execute(
      {
        method: "POST",
        url: `${base}/echo`,
        headers: { Accept: "application/json" },
        body: { a: 1 },
      },
      signal(),
    );
    expect(outcome).toMatchObject({
      ok: true,
      status: 200,
      body: { method: "POST", body: { a: 1 }, accept: "application/json" },
    });
  });

  test("returns text bodies and non-2xx statuses as responses", async () => {
    expect(
      await executor().execute({ method: "GET", url: `${base}/text` }, signal()),
    ).toMatchObject({
      ok: true,
      body: "hello",
    });
    expect(
      await executor().execute({ method: "GET", url: `${base}/missing` }, signal()),
    ).toMatchObject({
      ok: true,
      status: 404,
    });
  });

  test("enforces the response size cap", async () => {
    const outcome = await executor(100).execute({ method: "GET", url: `${base}/big` }, signal());
    expect(outcome).toMatchObject({ ok: false, error: { code: "too_large" } });
  });

  test("times out a slow server", async () => {
    const outcome = await executor().execute(
      { method: "GET", url: `${base}/slow`, timeoutMs: 100 },
      signal(),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  test("cancels on abort", async () => {
    const controller = new AbortController();
    const pending = executor().execute({ method: "GET", url: `${base}/slow` }, controller.signal);
    defaultTimer.setTimeout(() => controller.abort(), 50);
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  test("reports connection refused", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const url = `http://127.0.0.1:${closed.port}/`;
    await closed.stop(true);
    const outcome = await executor().execute({ method: "GET", url }, signal());
    expect(outcome).toMatchObject({ ok: false, error: { code: "connection_refused" } });
  });
});
