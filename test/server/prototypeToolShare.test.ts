import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
} from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeProtoViewerShareFiles } from "../fakes/FakeProtoViewerShareFiles";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolStructured } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "share-android", platform: "android", name: "Fake" };
const spec = {
  id: "demo",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
};

describe("prototype share action (#14128)", () => {
  let restore: () => void;
  let dispose: () => void;
  let proxy: FakeCtrlProxy;
  let files: FakeProtoViewerShareFiles;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    proxy = new FakeCtrlProxy(timer);
    files = new FakeProtoViewerShareFiles();
    dispose = registerPrototypeTools({
      clientFactory: () => proxy,
      store: new InMemoryPrototypeStatusStore(timer),
      timer,
      clock: timer,
      assetFileReader: new FakePrototypeAssetFileReader().addFile(
        "/specs/demo.json",
        Buffer.from(JSON.stringify(spec)),
      ),
      protoViewerShareFiles: files,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      lifecycle: {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: () => () => {},
        subscribeDeviceUnbound: () => () => {},
      },
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

  test("writes the bundle on the host from a specPath without a device request", async () => {
    const output = await call({ action: "share", specPath: "/specs/demo.json" });
    expect(output.success).toBe(true);
    expect(output.share?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...files.written.keys()]).toEqual([output.share!.bundlePath]);
    expect(proxy.saveRequests).toHaveLength(0);
  });

  test("refuses an http url with invalid_url", async () => {
    const output = await call({ action: "share", spec, url: "http://example.com/demo" });
    expect(output).toMatchObject({ success: false, errorCode: "invalid_url" });
    expect(files.written.size).toBe(0);
  });

  test("schema: share takes exactly one spec source, and url belongs to share only", () => {
    expect(prototypeSchema.safeParse({ action: "share" }).success).toBe(false);
    expect(prototypeSchema.safeParse({ action: "share", spec, specPath: "/x" }).success).toBe(
      false,
    );
    expect(
      prototypeSchema.safeParse({ action: "share", spec, url: "https://example.com/d" }).success,
    ).toBe(true);
    expect(prototypeSchema.safeParse({ action: "share", spec, label: "x" }).success).toBe(false);
    expect(
      prototypeSchema.safeParse({ action: "show", spec, url: "https://example.com/d" }).success,
    ).toBe(false);
  });
});
