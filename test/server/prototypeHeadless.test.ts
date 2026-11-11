import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readToolResponse } from "../helpers/toolResponse";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { VirtualPrototypeDevice } from "../../src/features/prototype/headless/VirtualPrototypeDevice";
import {
  VIRTUAL_PROTOTYPE_DEVICE,
  VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES,
} from "../../src/features/prototype/headless/headlessPrototypeMode";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const spec = (extra: Record<string, unknown> = {}) => ({
  id: "demo",
  window: { placement: { type: "fullscreen" } },
  state: { count: 0 },
  root: {
    type: "button",
    label: "Add",
    testTag: "add",
    onTap: [{ type: "emit", name: "added" }],
  },
  ...extra,
});

describe("prototype tool on the headless virtual device (#17974)", () => {
  let restore: () => void;
  let unsubscribe: () => void;
  let virtual: VirtualPrototypeDevice;
  let timer: FakeTimer;

  beforeEach(() => {
    restore = preserveToolRegistry();
    timer = new FakeTimer();
    virtual = new VirtualPrototypeDevice(timer);
    unsubscribe = registerPrototypeTools({
      virtualDevice: virtual,
      env: { AUTOMOBILE_HEADLESS: "1" },
      clock: timer,
      timer,
      lifecycle: {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: () => () => {},
        subscribeDeviceUnbound: () => () => {},
      },
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: Record<string, unknown>) {
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    const response = await handler({ ...VIRTUAL_PROTOTYPE_DEVICE }, input);
    return prototypeOutputSchema.parse(readToolResponse(response).structuredContent);
  }

  test("show lands on the virtual device and the result says it is virtual", async () => {
    const shown = await call({ action: "show", spec: spec() });
    expect(shown.success).toBe(true);
    expect(shown.virtualDevice).toEqual({
      deviceId: VIRTUAL_PROTOTYPE_DEVICE.deviceId,
      renderer: "web",
      unsupportedCapabilities: [...VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES],
    });
    expect(virtual.shownIds()).toEqual(["demo"]);
  });

  test("patch changes the shown prototype and inspect reports the new state", async () => {
    await call({ action: "show", spec: spec() });
    const patched = await call({
      action: "patch",
      id: "demo",
      baseRevision: 1,
      ops: [{ op: "replace", path: "/state/count", value: 3 }],
    });
    expect(patched.success).toBe(true);
    const inspected = await call({ action: "inspect" });
    expect(inspected.success).toBe(true);
    expect(inspected.prototypes).toMatchObject([{ id: "demo", state: { count: 3 } }]);
  });

  test("an input dispatched into the virtual device reaches awaitEvent", async () => {
    await call({ action: "show", spec: spec() });
    virtual.dispatch({ id: "demo", kind: "emit", name: "added" });
    const waited = await call({ action: "awaitEvent", id: "demo", timeoutMs: 1000 });
    expect(waited.success).toBe(true);
    expect(waited.event).toMatchObject({ id: "demo", kind: "emit", name: "added", sequence: 1 });
  });

  test("device-only actions are refused, not skipped", async () => {
    const saved = await call({ action: "listSaved" });
    expect(saved.success).toBe(false);
    expect(saved.error).toContain("needs a real device");
    expect(saved.virtualDevice?.renderer).toBe("web");
  });

  test("a spec needing a capability the virtual device lacks is refused", async () => {
    const refused = await call({
      action: "show",
      spec: spec({
        window: { placement: { type: "fullscreen" }, persistence: "device" },
      }),
    });
    expect(refused.success).toBe(false);
    expect(refused.virtualDevice?.unsupportedCapabilities).toContain("prototype_window_options_v1");
    expect(virtual.shownIds()).toEqual([]);
  });
});
