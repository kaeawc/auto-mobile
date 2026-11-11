import { afterEach, describe, expect, test } from "bun:test";
import { nodePreviewHttpBinder } from "../../../../src/features/prototype/preview/prototypePreviewHttp";
import { PrototypePreviewServer } from "../../../../src/features/prototype/preview/PrototypePreviewServer";
import { PrototypeSpecRevisions } from "../../../../src/features/prototype/prototypeSpecRevisions";
import { webResourcePreviewSource } from "../../../../src/server/prototypeTools/preview";
import { defaultTimer } from "../../../../src/utils/SystemTimer";

/**
 * The preview server over a real loopback socket on an OS-chosen port (#17975): the page is the
 * web resource's HTML, and a landed patch reaches an open page as a reload event within a second.
 */
const spec = (text: string) => ({
  id: "demo",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text },
});

let server: PrototypePreviewServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

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

describe("PrototypePreviewServer over loopback", () => {
  test("serves the page and pushes a reload within a second of a patch", async () => {
    const revisions = new PrototypeSpecRevisions(defaultTimer);
    revisions.recordShow("demo", { spec: spec("first"), platform: "android" });
    const source = webResourcePreviewSource({ revisions, rendererVersion: () => "test" });
    server = new PrototypePreviewServer({
      source,
      http: nodePreviewHttpBinder,
      timer: defaultTimer,
    });
    const info = await server.serve({ port: 0 });
    expect(info.host).toBe("127.0.0.1");
    expect(info.port).toBeGreaterThan(0);
    const pageUrl = server.pageUrl("demo")!;

    const shell = await fetch(pageUrl);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('data-page="/p/demo/page"');
    const first = await fetch(`${pageUrl}/page`);
    expect(await first.text()).toContain('data-revision="1"');

    const events = await fetch(`${pageUrl}/events`);
    expect(events.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = events.body!.getReader();
    await readUntil(reader, "event: ready", 1000);

    revisions.recordPatch("demo", { spec: spec("second"), platform: "android" });
    const pushed = await readUntil(reader, "event: reload", 1000);
    expect(pushed).toContain('"id":"demo"');
    const second = await fetch(`${pageUrl}/page`);
    expect(await second.text()).toContain('data-revision="2"');

    await server.stop();
    await reader.cancel().catch(() => undefined);
    const refused = await fetch(pageUrl).then(
      () => "answered",
      () => "refused",
    );
    expect(refused).toBe("refused");
  });
});
