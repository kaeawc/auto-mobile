import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_SHOW_IN_PLACE_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
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
    client.setSupportedCommands(["prototype_display_id_v1", PROTOTYPE_SHOW_IN_PLACE_CAPABILITY]);
    adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", { stdout: BOTH_PANELS, stderr: "" });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      clock: timer,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler(device, input);
    return prototypeOutputSchema.parse(response.structuredContent);
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
});
