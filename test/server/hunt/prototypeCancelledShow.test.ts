import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_SHOW_IN_PLACE_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { registerPrototypeTools } from "../../../src/server/prototypeTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { preserveToolRegistry } from "../../helpers/withTemporaryTool";

const BOTH_PANELS =
  'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}\n' +
  'Display id 2: DisplayInfo{uniqueId "local:inner-key" type INTERNAL, real 200 x 200}';
const device: BootedDevice = {
  deviceId: "hunt-cancel",
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

describe("a show cancelled while a capability lookup waits must never reach the device", () => {
  let client: FakeCtrlProxy;
  let restore: () => void;
  let unsubscribe: () => void;
  let controller: AbortController;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(["prototype_display_id_v1", PROTOTYPE_SHOW_IN_PLACE_CAPABILITY]);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", { stdout: BOTH_PANELS, stderr: "" });
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      clock: timer,
    });
    controller = new AbortController();
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  /** supportsCommand stands for the wait on connection + handshake; the request is cancelled in it. */
  function cancelDuringLookup(): void {
    const supports = client.supportsCommand.bind(client);
    client.supportsCommand = async (name: string) => {
      const answer = await supports(name);
      controller.abort();
      return answer;
    };
  }

  const run = (input: Record<string, unknown>) =>
    ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      input,
      undefined,
      controller.signal,
    );

  test("a display-targeted show", async () => {
    cancelDuringLookup();
    await run({ action: "show", spec, display: "inner" }).catch(() => undefined);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("an in-place show on a CtrlProxy without prototype_show_in_place_v1", async () => {
    client.setSupportedCommands([]);
    await run({ action: "show", spec });
    expect(client.getPrototypeHistory()).toHaveLength(1);
    cancelDuringLookup();
    await run({ action: "show", spec }).catch(() => undefined);
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });
});
