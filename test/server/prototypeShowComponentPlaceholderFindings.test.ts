import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { readToolResponse } from "../helpers/toolResponse";

const android = {
  deviceId: "props-android",
  platform: "android",
  name: "Fake Android",
} satisfies BootedDevice;

// The #19367 repro: component-prop placeholders are only detectable on the authored spec.
const spec = {
  id: "mt-props",
  window: { placement: { type: "fullscreen" } },
  components: {
    tag: {
      root: {
        type: "row",
        children: [
          { type: "text", text: "{props.name}" },
          { type: "chip", label: "{props.name}" },
          { type: "badge", text: "#{props.name}" },
          { type: "icon", name: "alarm_add", testTag: "glyph" },
        ],
      },
    },
  },
  root: {
    type: "column",
    children: [{ type: "use", component: "tag", props: { name: "Alpha" } }],
  },
};

describe("show lints the authored spec, not the component-expanded one (#19367)", () => {
  let restore: () => void;
  let unsubscribe: () => void;
  function register(): () => void {
    const timer = new FakeTimer();
    const client = new FakeCtrlProxy(timer);
    const agent = new FakePrototypeAgentClient();
    return registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: () => agent },
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  }
  beforeAll(async () => {
    // The tool loads its runtime on the first call: pay that once here, outside the timed tests.
    const restoreRegistry = preserveToolRegistry();
    const cleanup = register();
    try {
      await show();
    } finally {
      cleanup();
      restoreRegistry();
    }
  });
  beforeEach(() => {
    restore = preserveToolRegistry();
    unsubscribe = register();
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });
  async function show() {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(android, {
      action: "show",
      spec,
    });
    const raw = readToolResponse(response).structuredContent;
    return prototypeOutputSchema.parse(raw);
  }

  test("reports component-prop placeholders at their authored component paths", async () => {
    const payload = await show();
    expect(payload.success).toBe(true);
    expect(payload.placeholderFindings?.map((finding) => finding.path)).toEqual([
      "root.children[0] (use tag) → components.tag.root.children[1].label",
      "root.children[0] (use tag) → components.tag.root.children[2].text",
    ]);
  });

  test("locates accessibility findings inside a component at the authored path", async () => {
    const payload = await show();
    expect(payload.accessibilityFindings?.map((finding) => finding.path)).toContain(
      "root.children[0] (use tag) → components.tag.root.children[3]",
    );
  });
});
