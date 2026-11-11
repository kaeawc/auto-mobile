import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PrototypePreviewServer } from "../../src/features/prototype/preview/PrototypePreviewServer";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
} from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolStructured } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import {
  FakePreviewHttpBinder,
  FakePreviewPageSource,
} from "../features/prototype/preview/previewFakes";

const android: BootedDevice = { deviceId: "preview-android", platform: "android", name: "Fake" };

describe("prototype serve and stop actions (#17975)", () => {
  let restore: () => void;
  let dispose: () => void;
  let proxy: FakeCtrlProxy;
  let http: FakePreviewHttpBinder;
  let source: FakePreviewPageSource;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    proxy = new FakeCtrlProxy(timer);
    http = new FakePreviewHttpBinder();
    source = new FakePreviewPageSource();
    dispose = registerPrototypeTools({
      clientFactory: () => proxy,
      store: new InMemoryPrototypeStatusStore(timer),
      timer,
      clock: timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      lifecycle: {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: () => () => {},
        subscribeDeviceUnbound: () => () => {},
      },
      preview: { server: new PrototypePreviewServer({ source, http, timer }), source },
    });
  });
  afterEach(() => {
    dispose();
    restore();
  });
  const call = async (input: Record<string, unknown>) =>
    prototypeOutputSchema.parse(
      toolStructured(await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(android, input)),
    );

  test("serve returns the page URL without a device request; status reports it", async () => {
    source.change("checkout");
    const served = await call({ action: "serve", id: "checkout", port: 8765 });
    expect(served).toMatchObject({
      success: true,
      previewServer: {
        running: true,
        url: "http://127.0.0.1:8765/",
        pageUrl: "http://127.0.0.1:8765/p/checkout",
        host: "127.0.0.1",
        port: 8765,
        remote: false,
      },
    });
    expect(served.warning).toBeUndefined();
    expect(proxy.getPrototypeHistory()).toEqual([]);
    const status = await call({ action: "status" });
    expect(status.previewServer?.url).toBe("http://127.0.0.1:8765/");
  });

  test("serve of an id not shown yet warns; stop closes the port", async () => {
    const served = await call({ action: "serve", id: "later" });
    expect(served.warning).toContain('"later" has no web output yet');
    const stopped = await call({ action: "stop" });
    expect(stopped.previewServer).toEqual({ running: false, stoppedReason: "stop" });
    expect(http.closed).toBe(1);
    const status = await call({ action: "status" });
    expect(status.previewServer).toEqual({ running: false, stoppedReason: "stop" });
  });

  test("a port in use fails the call with the reason", async () => {
    http.failWith = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    const output = await call({ action: "serve", port: 9999 });
    expect(output.success).toBe(false);
    expect(output.error).toContain("Port 9999 is already in use");
  });

  test("status omits previewServer before the first serve", async () => {
    expect((await call({ action: "status" })).previewServer).toBeUndefined();
  });

  test("schema: serve takes id, port, remote and idleTimeoutMs; other actions refuse them", () => {
    const parse = (input: Record<string, unknown>) => prototypeSchema.safeParse(input).success;
    expect(parse({ action: "serve", id: "a", port: 0, remote: true, idleTimeoutMs: 60000 })).toBe(
      true,
    );
    expect(parse({ action: "stop" })).toBe(true);
    expect(parse({ action: "stop", port: 1 })).toBe(false);
    expect(parse({ action: "status", remote: true })).toBe(false);
    expect(parse({ action: "serve", port: 70000 })).toBe(false);
    expect(parse({ action: "serve", idleTimeoutMs: 10 })).toBe(false);
  });
});
