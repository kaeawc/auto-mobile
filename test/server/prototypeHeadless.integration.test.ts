import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readToolResponse } from "../helpers/toolResponse";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { VirtualPrototypeDevice } from "../../src/features/prototype/headless/VirtualPrototypeDevice";
import { VIRTUAL_PROTOTYPE_DEVICE_ID } from "../../src/features/prototype/headless/headlessPrototypeMode";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import { readPrototypeWebResource } from "../../src/features/prototype/web/prototypeWebResource";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

/**
 * Headless prototype mode end to end through the registry (#17974): with AUTOMOBILE_HEADLESS=1
 * the registry resolves no device, so show, inspect, awaitEvent and the /web page all work with
 * no adb, emulator or simulator, which is how this machine runs.
 */
describe("headless prototype mode through the tool registry (#17974)", () => {
  let restoreRegistry: () => void;
  let unsubscribe: () => void;
  let restoreCollaborators: () => void;
  let virtual: VirtualPrototypeDevice;
  let revisions: PrototypeSpecRevisions;

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
    revisions = new PrototypeSpecRevisions(timer);
    virtual = new VirtualPrototypeDevice(timer);
    unsubscribe = registerPrototypeTools({
      virtualDevice: virtual,
      env: { AUTOMOBILE_HEADLESS: "1" },
      store: new InMemoryPrototypeStatusStore(timer, undefined, revisions),
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
    restoreCollaborators();
    restoreRegistry();
  });

  async function call(input: Record<string, unknown>) {
    const response = await ToolRegistry.getTool("prototype")!.handler(input);
    return prototypeOutputSchema.parse(readToolResponse(response).structuredContent);
  }

  test("show -> inspect -> awaitEvent -> /web with no device", async () => {
    const shown = await call({
      action: "show",
      spec: {
        id: "checkout",
        window: { placement: { type: "fullscreen" } },
        state: { quantity: 1 },
        root: {
          type: "column",
          children: [
            { type: "text", text: "Checkout" },
            {
              type: "button",
              label: "Pay",
              testTag: "pay",
              onTap: [{ type: "emit", name: "paid" }],
            },
          ],
        },
      },
    });
    expect(shown.success).toBe(true);
    expect(shown.virtualDevice?.deviceId).toBe(VIRTUAL_PROTOTYPE_DEVICE_ID);

    const inspected = await call({ action: "inspect" });
    expect(inspected.success).toBe(true);
    expect(inspected.prototypes).toMatchObject([{ id: "checkout", state: { quantity: 1 } }]);

    virtual.dispatch({ id: "checkout", kind: "emit", name: "paid", payload: { total: 12 } });
    const waited = await call({ action: "awaitEvent", id: "checkout", eventName: "paid" });
    expect(waited.success).toBe(true);
    expect(waited.event).toMatchObject({ kind: "emit", name: "paid", payload: { total: 12 } });

    const web = await readPrototypeWebResource(revisions, { id: "checkout" }, "test");
    expect(web.html).toContain("<html");
    expect(web.html).toContain("Checkout");
  });
});
