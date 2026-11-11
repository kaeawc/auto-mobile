import { beforeEach, describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import { DEFAULT_PROTOTYPE_PREVIEW_IDLE_TIMEOUT_MS } from "../../../../src/features/prototype/preview/prototypePreviewLimits";
import {
  PROTOTYPE_PREVIEW_KEEPALIVE_MS,
  PrototypePreviewServer,
} from "../../../../src/features/prototype/preview/PrototypePreviewServer";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakePreviewHttpBinder, FakePreviewPageSource } from "./previewFakes";

let timer: FakeTimer;
let http: FakePreviewHttpBinder;
let source: FakePreviewPageSource;
let server: PrototypePreviewServer;

beforeEach(() => {
  timer = new FakeTimer();
  http = new FakePreviewHttpBinder();
  source = new FakePreviewPageSource();
  server = new PrototypePreviewServer({ source, http, timer });
});

const LOCAL = { host: "127.0.0.1:40000" };

describe("PrototypePreviewServer lifecycle", () => {
  test("serve binds loopback on a free port and reports the URL", async () => {
    expect(server.info()).toBeUndefined();
    const info = await server.serve({});
    expect(http.binds).toEqual([{ host: "127.0.0.1", port: 0 }]);
    expect(info).toEqual({
      running: true,
      url: "http://127.0.0.1:40000/",
      host: "127.0.0.1",
      port: 40000,
      remote: false,
      idleTimeoutMs: DEFAULT_PROTOTYPE_PREVIEW_IDLE_TIMEOUT_MS,
    });
    expect(server.pageUrl("a b")).toBe("http://127.0.0.1:40000/p/a%20b");
  });

  test("remote binds every interface; a repeated serve keeps the server", async () => {
    await server.serve({ remote: true, port: 8123 });
    const again = await server.serve({ remote: true });
    expect(http.binds).toEqual([{ host: "0.0.0.0", port: 8123 }]);
    expect(again.port).toBe(8123);
  });

  test("another port or exposure restarts the server", async () => {
    await server.serve({});
    await server.serve({ port: 9000 });
    expect(http.closed).toBe(1);
    expect(server.info()?.port).toBe(9000);
  });

  test("stop closes the port, ends open pages and reports the reason", async () => {
    await server.serve({});
    const stream = http.request("/p/a/events", LOCAL);
    const info = await server.stop();
    expect(info).toEqual({ running: false, stoppedReason: "stop" });
    expect(http.closed).toBe(1);
    expect(stream.ended).toBe(true);
    expect(source.listenerCount).toBe(0);
    expect(timer.getPendingIntervals()).toEqual([]);
  });

  test("daemon stop reports daemon; stop when not running is a no-op", async () => {
    expect(await server.stop()).toEqual({ running: false });
    await server.serve({});
    await server.stop("daemon");
    expect(server.info()).toEqual({ running: false, stoppedReason: "daemon" });
  });

  test("a port in use is an actionable error", async () => {
    http.failWith = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    const failure = server.serve({ port: 8080 });
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toThrow("Port 8080 is already in use");
    expect(server.info()).toBeUndefined();
  });
});

describe("PrototypePreviewServer idle timeout", () => {
  test("stops after the idle timeout with no page open", async () => {
    await server.serve({ idleTimeoutMs: 5000 });
    await timer.advanceTimersByTimeAsync(4999);
    expect(server.info()?.running).toBe(true);
    await timer.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(server.info()).toEqual({ running: false, stoppedReason: "idle" });
    expect(http.closed).toBe(1);
  });

  test("requests and changes restart the countdown", async () => {
    await server.serve({ idleTimeoutMs: 5000 });
    await timer.advanceTimersByTimeAsync(4000);
    http.request("/", LOCAL);
    await timer.advanceTimersByTimeAsync(4000);
    source.change("a");
    await timer.advanceTimersByTimeAsync(4000);
    expect(server.info()?.running).toBe(true);
  });

  test("an open page holds the server; closing it restarts the countdown", async () => {
    await server.serve({ idleTimeoutMs: 5000 });
    const stream = http.request("/p/a/events", LOCAL);
    await timer.advanceTimersByTimeAsync(60_000);
    expect(server.info()?.running).toBe(true);
    stream.closeClient();
    await timer.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    expect(server.info()?.running).toBe(false);
  });
});

describe("PrototypePreviewServer event streams", () => {
  test("a stream opens with ready and gets reload for its id and its variants", async () => {
    await server.serve({});
    source.groups.set("a", ["a", "b"]);
    const stream = http.request("/p/a/events", LOCAL);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(stream.body).toBe('retry: 1000\n\nevent: ready\ndata: {"generation":1}\n\n');
    source.change("a");
    source.change("other");
    source.change("b");
    expect(stream.chunks.slice(1)).toEqual([
      'event: reload\ndata: {"id":"a","generation":2}\n\n',
      'event: reload\ndata: {"id":"b","generation":4}\n\n',
    ]);
  });

  test("a variant that left the group still reloads the page once", async () => {
    await server.serve({});
    source.groups.set("a", ["a", "b"]);
    const stream = http.request("/p/a/events", LOCAL);
    source.groups.set("a", ["a"]);
    source.change("b");
    source.change("b");
    expect(stream.chunks.length).toBe(2);
  });

  test("a restart advances the generation, so a reconnecting tab reloads", async () => {
    await server.serve({ port: 8123 });
    const before = http.request("/p/a/events", { host: "127.0.0.1:8123" });
    await server.stop();
    source.change("a");
    await server.serve({ port: 8123 });
    const after = http.request("/p/a/events", { host: "127.0.0.1:8123" });
    expect(before.body).toContain('event: ready\ndata: {"generation":1}');
    expect(after.body).toContain('event: ready\ndata: {"generation":2}');
  });

  test("keepalive comments go to open streams", async () => {
    await server.serve({});
    const stream = http.request("/p/a/events", LOCAL);
    await timer.advanceTimersByTimeAsync(PROTOTYPE_PREVIEW_KEEPALIVE_MS);
    expect(stream.chunks.at(-1)).toBe(": keepalive\n\n");
  });
});

describe("PrototypePreviewServer requests", () => {
  test("serves the shell and the page", async () => {
    await server.serve({});
    source.change("a");
    source.groups.set("a", ["a", "b"]);
    const page = http.request("/p/a/page?variant=b&frame=pixel-9", LOCAL);
    await page.done();
    expect(page.status).toBe(200);
    expect(page.body).toBe("<page a b pixel-9>");
    const shell = http.request("/p/a", LOCAL);
    await shell.done();
    expect(shell.body).toContain('data-page="/p/a/page"');
  });

  test("refuses other hosts unless remote, and methods other than GET", async () => {
    await server.serve({});
    const rebound = http.request("/", { host: "evil.example:40000" });
    expect(rebound.status).toBe(421);
    const localhost = http.request("/", { host: "localhost:40000" });
    await localhost.done();
    expect(localhost.status).toBe(200);
    const post = http.request("/", { ...LOCAL, method: "POST" });
    expect(post.status).toBe(405);
    await server.serve({ remote: true });
    const remote = http.request("/", { host: "192.168.1.5:40001" });
    await remote.done();
    expect(remote.status).toBe(200);
  });

  test("a page that fails to render is a 500 with the reason logged", async () => {
    await server.serve({});
    source.change("a");
    source.failPage = new Error("boom");
    const page = http.request("/p/a/page", LOCAL);
    await page.done();
    expect(page.status).toBe(500);
  });
});
