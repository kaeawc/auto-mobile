import { createExecResult } from "../../src/utils/execResult";
import { toolStructured } from "../helpers/toolResponse";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_SHOW_IN_PLACE_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const BOTH_PANELS =
  'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}\n' +
  'Display id 2: DisplayInfo{uniqueId "local:inner-key" type INTERNAL, real 200 x 200}';
const device: BootedDevice = {
  deviceId: "hunt-supersede",
  platform: "android",
  name: "Fold",
  displays: {
    panels: [
      { key: "inner-key", role: "inner", sizePx: { width: 200, height: 200 } },
      { key: "cover-key", role: "cover", sizePx: { width: 100, height: 100 } },
    ],
    postures: ["opened", "closed"],
  },
};
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "text" as const, text: "Hello" },
};

describe("a refused show must not supersede a valid in-flight show of the same id", () => {
  let client: FakeCtrlProxy;
  let adb: FakeAdbExecutor;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    // No prototype_appearance_v1: a pinned appearance is refused.
    client.setSupportedCommands(["prototype_display_id_v2", PROTOTYPE_SHOW_IN_PLACE_CAPABILITY]);
    adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", createExecResult(BOTH_PANELS, ""));
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      clock: timer,
      assetFileReader: new FakePrototypeAssetFileReader().addFile(
        "/img/logo.png",
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(4),
        ]),
      ),
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return prototypeOutputSchema.parse(toolStructured(response));
  }

  test("an appearance-refused newer show leaves the older show to be sent", async () => {
    const lookup = adb.executeCommand.bind(adb);
    let release!: () => void;
    let stalledNotify!: () => void;
    const stalled = new Promise<void>((resolve) => (stalledNotify = resolve));
    let lookups = 0;
    adb.executeCommand = async (...args) => {
      if (lookups++ === 0) {
        await new Promise<void>((resolve) => {
          release = resolve;
          stalledNotify();
        });
      }
      return lookup(...args);
    };
    const older = call({ action: "show", spec, display: "inner" });
    await stalled;
    const newer = await call({ action: "show", spec, appearance: "dark" });
    expect(newer.success).toBe(false);
    expect(newer.error).toContain("prototype_appearance_v1");
    release();
    const olderPayload = await older;
    // The newer show was refused and never reached the device, so nothing is "on screen" that
    // supersedes the older one: the older show must still be sent.
    expect(olderPayload.error).toBeUndefined();
    expect(olderPayload.success).toBe(true);
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });

  /** Stalls the first n adb display lookups; releases[i] resumes lookup i. */
  function stallLookups(count: number): { started: Promise<void>[]; releases: Array<() => void> } {
    const lookup = adb.executeCommand.bind(adb);
    const releases: Array<() => void> = [];
    const notifies: Array<() => void> = [];
    const started = Array.from(
      { length: count },
      (_, index) => new Promise<void>((resolve) => (notifies[index] = resolve)),
    );
    let lookups = 0;
    adb.executeCommand = async (...args) => {
      const index = lookups++;
      if (index < count) {
        await new Promise<void>((resolve) => {
          releases[index] = resolve;
          notifies[index]();
        });
      }
      return lookup(...args);
    };
    return { started, releases };
  }

  test("a late refusal does not overwrite a newer valid show's host state", async () => {
    const { started, releases } = stallLookups(2);
    const first = call({ action: "show", spec, display: "inner" });
    await started[0];
    const refused = call({ action: "show", spec, display: "inner", appearance: "dark" });
    await started[1];
    const newest = await call({ action: "show", spec });
    expect(newest.success).toBe(true);
    const before = await call({ action: "status" });
    releases[1]();
    const refusedPayload = await refused;
    expect(refusedPayload.success).toBe(false);
    const after = await call({ action: "status" });
    expect(after.lastResult).toEqual(before.lastResult);
    expect(after.prototypes).toEqual(before.prototypes);
    expect(after.lastResult?.success).toBe(true);
    releases[0]();
    const firstPayload = await first;
    expect(firstPayload.success).toBe(false);
    expect(firstPayload.error).toContain("newer show");
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });

  test("a show already sent is not withdrawn when its asset repair is cancelled", async () => {
    const { started, releases } = stallLookups(1);
    const older = call({ action: "show", spec, display: "inner" });
    await started[0];
    client.setPrototypeResult({ success: true, missingAssets: ["logo"] });
    const putAsset = client.requestPutPrototypeAsset.bind(client);
    let puts = 0;
    client.requestPutPrototypeAsset = async (asset, options) => {
      puts += 1;
      if (puts === 2) {
        throw new Error("aborted during repair");
      }
      return putAsset(asset, options);
    };
    const newer = await call({
      action: "show",
      spec: { ...spec, root: { type: "image", asset: "logo" } },
      assets: [{ id: "logo", path: "/img/logo.png" }],
    });
    expect(newer.success).toBe(true);
    expect(puts).toBe(2);
    expect(client.getPrototypeHistory()).toHaveLength(1);
    releases[0]();
    const olderPayload = await older;
    expect(olderPayload.success).toBe(false);
    expect(olderPayload.error).toContain("newer show");
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });
});
