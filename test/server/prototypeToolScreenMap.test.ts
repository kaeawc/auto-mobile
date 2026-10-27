import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
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
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolStructured } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "map-android", platform: "android", name: "Fake" };
const specText = fs.readFileSync(
  path.join(import.meta.dir, "../fixtures/prototype-spec/valid/stack-navigation.json"),
  "utf8",
);

describe("prototype screenMap action (#14125)", () => {
  let restore: () => void;
  let dispose: () => void;
  let proxy: FakeCtrlProxy;
  let reader: FakePrototypeAssetFileReader;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    proxy = new FakeCtrlProxy(timer);
    reader = new FakePrototypeAssetFileReader().addFile("/specs/nav.json", Buffer.from(specText));
    dispose = registerPrototypeTools({
      clientFactory: () => proxy,
      store: new InMemoryPrototypeStatusStore(timer),
      timer,
      clock: timer,
      assetFileReader: reader,
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

  test("returns the map and Mermaid for an inline spec without touching the device", async () => {
    const output = await call({ action: "screenMap", spec: JSON.parse(specText) });
    expect(output.success).toBe(true);
    expect(output.screenMap?.nodes.map((n) => n.id)).toContain("stack:nav/detail");
    expect(output.screenMap?.edges).toHaveLength(4);
    expect(output.mermaid).toStartWith("flowchart TD");
  });

  test("reads a specPath", async () => {
    const output = await call({ action: "screenMap", specPath: "/specs/nav.json" });
    expect(output.screenMap?.edges.map((e) => e.action)).toEqual([
      "push",
      "pop",
      "popToRoot",
      "replace",
    ]);
  });

  test("schema requires exactly one of spec or specPath and rejects other fields", () => {
    expect(prototypeSchema.safeParse({ action: "screenMap" }).success).toBe(false);
    expect(
      prototypeSchema.safeParse({ action: "screenMap", spec: {}, specPath: "/x" }).success,
    ).toBe(false);
    expect(
      prototypeSchema.safeParse({ action: "screenMap", id: "x", specPath: "/x" }).success,
    ).toBe(false);
  });
});
