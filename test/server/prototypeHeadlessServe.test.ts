import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VirtualPrototypeDevice } from "../../src/features/prototype/headless/VirtualPrototypeDevice";
import { VIRTUAL_PROTOTYPE_DEVICE } from "../../src/features/prototype/headless/headlessPrototypeMode";
import { PrototypePreviewServer } from "../../src/features/prototype/preview/PrototypePreviewServer";
import { revisionPreviewPageSource } from "../../src/features/prototype/preview/prototypePreviewSource";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { readToolResponse } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { FakePreviewHttpBinder } from "../features/prototype/preview/previewFakes";

const spec = (text = "Cart") => ({
  id: "cart",
  window: { placement: { type: "fullscreen" } },
  state: { count: 0 },
  root: { type: "text", text },
});

/** serve paired with headless mode (#17975, #17974): the virtual device feeds the preview server. */
describe("prototype serve on the headless virtual device", () => {
  let restore: () => void;
  let dispose: () => void;
  let http: FakePreviewHttpBinder;
  let revisions: PrototypeSpecRevisions;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    http = new FakePreviewHttpBinder();
    revisions = new PrototypeSpecRevisions(timer);
    // Pages name the revision they render, so a test can see which output the server serves.
    const source = revisionPreviewPageSource(
      revisions,
      async ({ id }) => `<page ${id} r${revisions.revision(id).revision}>`,
    );
    dispose = registerPrototypeTools({
      virtualDevice: new VirtualPrototypeDevice(timer),
      env: { AUTOMOBILE_HEADLESS: "1" },
      store: new InMemoryPrototypeStatusStore(timer, undefined, revisions),
      clock: timer,
      timer,
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

  async function call(input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler({ ...VIRTUAL_PROTOTYPE_DEVICE }, input);
    return prototypeOutputSchema.parse(readToolResponse(response).structuredContent);
  }

  test("serve after a headless show returns the page URL and status reports it", async () => {
    expect((await call({ action: "show", spec: spec() })).success).toBe(true);
    const served = await call({ action: "serve", id: "cart", port: 8765 });
    expect(served).toMatchObject({
      success: true,
      previewServer: { running: true, pageUrl: "http://127.0.0.1:8765/p/cart" },
      virtualDevice: { deviceId: VIRTUAL_PROTOTYPE_DEVICE.deviceId },
    });
    expect(served.warning).toBeUndefined();
    const status = await call({ action: "status" });
    expect(status.previewServer?.url).toBe("http://127.0.0.1:8765/");
  });

  test("a patch and a re-show on the virtual device reload the open page", async () => {
    await call({ action: "show", spec: spec() });
    await call({ action: "serve", id: "cart", port: 8765 });
    const page = http.request("/p/cart/page", { host: "127.0.0.1:8765" });
    await page.done();
    expect(page.body).toBe("<page cart r1>");
    const events = http.request("/p/cart/events", { host: "127.0.0.1:8765" });

    const patched = await call({
      action: "patch",
      id: "cart",
      baseRevision: 1,
      ops: [{ op: "replace", path: "/state/count", value: 2 }],
    });
    expect(patched.success).toBe(true);
    expect(events.body.match(/event: reload/g)).toHaveLength(1);

    await call({ action: "show", spec: spec("Bag") });
    expect(events.body.match(/event: reload/g)).toHaveLength(2);
    expect(events.body).toContain('"id":"cart"');

    const reread = http.request("/p/cart/page", { host: "127.0.0.1:8765" });
    await reread.done();
    expect(reread.body).toBe("<page cart r3>");
    events.closeClient();
  });

  test("serve for an id not yet shown headlessly warns; stop releases the port", async () => {
    const served = await call({ action: "serve", id: "later" });
    expect(served.warning).toContain('"later" has no web output yet');
    const stopped = await call({ action: "stop" });
    expect(stopped).toMatchObject({ success: true, previewServer: { running: false } });
    expect(http.closed).toBe(1);
  });
});
