import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VirtualPrototypeDevice } from "../../src/features/prototype/headless/VirtualPrototypeDevice";
import { VIRTUAL_PROTOTYPE_DEVICE_ID } from "../../src/features/prototype/headless/headlessPrototypeMode";
import { nodePreviewHttpBinder } from "../../src/features/prototype/preview/prototypePreviewHttp";
import { PrototypePreviewServer } from "../../src/features/prototype/preview/PrototypePreviewServer";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { webResourcePreviewSource } from "../../src/server/prototypeTools/preview";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import { readToolResponse } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

/**
 * The live preview server paired with headless mode (#17975, #17974): with AUTOMOBILE_HEADLESS=1
 * the registry resolves no device, a show lands on the in-memory virtual device, serve publishes
 * its page over a real loopback socket, and a patch on the virtual device reloads the open page.
 */
const spec = {
  id: "cart",
  window: { placement: { type: "fullscreen" } },
  state: { count: 0 },
  root: { type: "text", text: "Cart" },
};

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(marker)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`no ${marker} within ${timeoutMs} ms; got ${JSON.stringify(text)}`);
    }
    let handle: NodeJS.Timeout | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        handle = defaultTimer.setTimeout(
          () => reject(new Error(`no ${marker} within ${timeoutMs} ms`)),
          remaining,
        );
      }),
    ]).finally(() => handle && defaultTimer.clearTimeout(handle));
    if (chunk.done) {
      throw new Error(`stream ended before ${marker}`);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe("prototype serve on the headless virtual device (#17975)", () => {
  let restoreRegistry: () => void;
  let restoreCollaborators: () => void;
  let unsubscribe: () => void;
  let server: PrototypePreviewServer;

  beforeEach(() => {
    restoreRegistry = preserveToolRegistry();
    const original = ToolRegistry.getCollaboratorsForTesting();
    const timer = new FakeTimer();
    timer.setCurrentTime(1_700_000_000_000);
    ToolRegistry.setCollaboratorsForTesting({
      timer,
      toolCallRepository: { recordToolCall: async () => {} },
    });
    restoreCollaborators = () =>
      ToolRegistry.setCollaboratorsForTesting({
        timer: original.timer,
        toolCallRepository: original.toolCallRepository,
      });
    const revisions = new PrototypeSpecRevisions(timer);
    const source = webResourcePreviewSource({ revisions, rendererVersion: () => "test" });
    server = new PrototypePreviewServer({
      source,
      http: nodePreviewHttpBinder,
      timer: defaultTimer,
    });
    unsubscribe = registerPrototypeTools({
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
      preview: { server, source },
    });
  });
  afterEach(async () => {
    await server.stop();
    unsubscribe();
    restoreCollaborators();
    restoreRegistry();
  });

  async function call(input: Record<string, unknown>) {
    const response = await ToolRegistry.getTool("prototype")!.handler(input);
    return prototypeOutputSchema.parse(readToolResponse(response).structuredContent);
  }

  test("show -> serve -> fetch page -> patch -> reload event with no device", async () => {
    const shown = await call({ action: "show", spec });
    expect(shown.success).toBe(true);
    expect(shown.virtualDevice?.deviceId).toBe(VIRTUAL_PROTOTYPE_DEVICE_ID);

    const served = await call({ action: "serve", id: "cart", port: 0 });
    expect(served.success).toBe(true);
    expect(served.warning).toBeUndefined();
    expect(served.virtualDevice?.deviceId).toBe(VIRTUAL_PROTOTYPE_DEVICE_ID);
    expect(served.previewServer?.host).toBe("127.0.0.1");
    const pageUrl = served.previewServer!.pageUrl!;
    expect(pageUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/cart$/);

    const shell = await fetch(pageUrl);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('data-page="/p/cart/page"');
    const first = await (await fetch(`${pageUrl}/page`)).text();
    expect(first).toContain("Cart");
    expect(first).toContain('data-revision="1"');

    const events = await fetch(`${pageUrl}/events`);
    const reader = events.body!.getReader();
    await readUntil(reader, "event: ready", 1000);

    const patched = await call({
      action: "patch",
      id: "cart",
      baseRevision: 1,
      ops: [{ op: "replace", path: "/state/count", value: 2 }],
    });
    expect(patched.success).toBe(true);
    const pushed = await readUntil(reader, "event: reload", 1000);
    expect(pushed).toContain('"id":"cart"');
    expect(await (await fetch(`${pageUrl}/page`)).text()).toContain('data-revision="2"');

    const reshown = await call({
      action: "show",
      spec: { ...spec, root: { type: "text", text: "Bag" } },
    });
    expect(reshown.success).toBe(true);
    const again = await readUntil(reader, "event: reload", 1000);
    expect(again).toContain('"id":"cart"');
    expect(await (await fetch(`${pageUrl}/page`)).text()).toContain("Bag");

    const stopped = await call({ action: "stop" });
    expect(stopped.success).toBe(true);
    await reader.cancel().catch(() => undefined);
    const refused = await fetch(pageUrl).then(
      () => "answered",
      () => "refused",
    );
    expect(refused).toBe("refused");
  });
});
