import { readToolEnvelopePayload } from "../../../src/utils/toolEnvelopePayload";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PROTOTYPE_PAGER_OPTIONS_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import {
  prototypePagerOptionFields,
  prototypePagerOptionsUnsupportedMessage,
} from "../../../src/features/prototype/prototypePagerOptions";
import {
  MAX_PROTOTYPE_PAGER_DP,
  prototypeSpecSchema,
} from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";
import { prototypeOutputSchema, registerPrototypeTools } from "../../../src/server/prototypeTools";
import { IosPrototypeTransport } from "../../../src/features/prototype/ios/iosPrototypeTransport";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { BootedDevice } from "../../../src/models";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import {
  FakePrototypeAgentClient,
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
} from "../../fakes/FakePrototypeAgentClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { preserveToolRegistry } from "../../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "pager-android", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "pager-ios", platform: "ios", name: "Fake" };
const pager = { type: "pager", id: "pages", children: [{ type: "spacer" }, { type: "spacer" }] };
const spec = (root: unknown = pager) => ({
  id: "panel",
  window: { placement: { type: "fullscreen" }, opacity: 1 },
  root,
});
const componentSpec = () => ({
  ...spec({ type: "use", component: "pageDeck" }),
  components: { pageDeck: { root: { ...pager, axis: "vertical", peek: { start: 20 } } } },
});

beforeAll(() => {
  validatePrototypeSpec(spec());
});

describe("pager option contract", () => {
  test("guide distinguishes selected-page semantics by platform and renderer path", () => {
    const guide = renderPrototypeGuide();
    expect(guide).toContain(
      "Android marks the current page selected only for pagers with positive peek or a fixed pageSize",
    );
    expect(guide).toContain(
      "iOS marks it selected on the options path (a pager with any non-default option) and not on the legacy paged pager",
    );
    expect(guide).toContain("plain pagers expose only the current page on both");
    expect(guide).not.toContain("the current page is reported selected");
  });

  test("component-expanded pager options use expanded paths", () => {
    const candidate = componentSpec();
    const expanded = validatePrototypeSpec(candidate);
    expect(expanded.success).toBe(true);
    if (!expanded.success) {
      return;
    }
    expect(prototypePagerOptionFields(expanded.data)).toEqual(["root.axis", "root.peek"]);
    expect(
      prototypePagerOptionFields(spec({ ...pager, axis: "vertical", peek: { start: 20 } })),
    ).toEqual(["root.axis", "root.peek"]);
  });
  test("malformed specs are scanned defensively", () => {
    expect(prototypePagerOptionFields({ root: null })).toEqual([]);
    expect(prototypePagerOptionFields({ root: { type: "pager", children: [null] } })).toEqual([]);
  });
  test("plain pager validates and keeps optional fields absent", () => {
    const result = validatePrototypeSpec(spec());
    expect(result.success).toBe(true);
    expect(prototypePagerOptionFields(spec())).toEqual([]);
    if (result.success) {
      expect(prototypePagerOptionFields(result.data)).toEqual([]);
    }
  });
  test("finds only pager fields in document order, including child paths", () => {
    expect(
      prototypePagerOptionFields(
        spec({
          type: "column",
          children: [
            { ...pager, peek: {}, axis: "horizontal", pageSize: "fill", pageSpacing: 0 },
            {
              type: "scroll",
              axis: "horizontal",
              child: { ...pager, id: "nested", axis: "vertical" },
            },
          ],
        }),
      ),
    ).toEqual([
      "root.children[0].peek",
      "root.children[0].axis",
      "root.children[0].pageSize",
      "root.children[0].pageSpacing",
      "root.children[1].child.axis",
    ]);
    expect(prototypePagerOptionFields(null)).toEqual([]);
    expect(
      prototypePagerOptionFields(spec({ type: "text", text: "axis", axis: "vertical" })),
    ).toEqual([]);
  });
  test.each(["android", "ios"] as const)(
    "%s refusal names capability, first field and count",
    (platform) => {
      const message = prototypePagerOptionsUnsupportedMessage(["root.peek", "root.axis"], platform);
      expect(message).toContain(PROTOTYPE_PAGER_OPTIONS_CAPABILITY);
      expect(message).toContain("root.peek (and 1 more)");
      expect(message).toContain("Nothing was shown.");
      expect(message).toContain(
        platform === "ios" ? "launchApp prototype: true" : "Update the connected CtrlProxy",
      );
      expect(message).toContain("remove the pager options");
      expect(prototypePagerOptionsUnsupportedMessage(["root.axis"], platform)).not.toContain(
        " more)",
      );
    },
  );
  test.each([
    [{ pageSpacing: 0, peek: {}, pageSize: "fill", axis: "horizontal" }, true],
    [
      {
        pageSpacing: MAX_PROTOTYPE_PAGER_DP,
        peek: { start: 0, end: MAX_PROTOTYPE_PAGER_DP },
        pageSize: { dp: 1e-6 },
        axis: "vertical",
      },
      true,
    ],
    [{ pageSize: { dp: MAX_PROTOTYPE_PAGER_DP } }, true],
    [{ pageSpacing: -1 }, false],
    [{ pageSpacing: MAX_PROTOTYPE_PAGER_DP + 1 }, false],
    [{ pageSpacing: Infinity }, false],
    [{ peek: { end: NaN } }, false],
    [{ peek: { start: Infinity } }, false],
    [{ peek: { end: -1 } }, false],
    [{ peek: { end: MAX_PROTOTYPE_PAGER_DP + 1 } }, false],
    [{ peek: { unknown: 0 } }, false],
    [{ pageSize: { dp: 0 } }, false],
    [{ pageSize: { dp: MAX_PROTOTYPE_PAGER_DP + 1 } }, false],
    [{ pageSize: { dp: 1, extra: 2 } }, false],
    [{ pageSize: "wrap" }, false],
    [{ axis: "diagonal" }, false],
  ] as const)("MAX_PROTOTYPE_PAGER_DP bounds agree for %j", (options, valid) => {
    const candidate = spec({ ...pager, ...options });
    expect(validatePrototypeSpec(candidate).success).toBe(valid);
    expect(prototypeSpecSchema.safeParse(candidate).success).toBe(valid);
  });
  test("horizontal pager in vertical scroll remains valid", () => {
    expect(
      validatePrototypeSpec(spec({ type: "scroll", child: { ...pager, axis: "horizontal" } }))
        .success,
    ).toBe(true);
  });
  test("an unrelated vertical scroll is not an ancestor", () => {
    expect(
      validatePrototypeSpec(
        spec({
          type: "column",
          children: [
            { type: "scroll", child: { type: "spacer" } },
            { ...pager, axis: "vertical" },
          ],
        }),
      ).success,
    ).toBe(true);
  });
});

describe("pager options host refusal", () => {
  let client: FakeCtrlProxy;
  let agent: FakePrototypeAgentClient;
  let restore: () => void;
  let unsubscribe: () => void;
  const lookups: string[] = [];
  function register() {
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    agent = new FakePrototypeAgentClient({
      agentVersion: "test",
      protocolVersion: 1,
      capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES],
    });
    const supports = client.supportsCommand.bind(client);
    client.supportsCommand = async (name) => {
      lookups.push(name);
      return supports(name);
    };
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: () => agent },
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
  }
  const runSpec = (device: BootedDevice, candidate: unknown, signal?: AbortSignal) =>
    ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      { action: "show", spec: candidate },
      undefined,
      signal,
    );
  const run = (device: BootedDevice, root: unknown, signal?: AbortSignal) =>
    runSpec(device, spec(root), signal);
  beforeAll(async () => {
    const restoreWarmup = preserveToolRegistry();
    register();
    try {
      await run(android, pager);
      await run(ios, pager);
    } finally {
      unsubscribe();
      restoreWarmup();
    }
  });
  beforeEach(() => {
    restore = preserveToolRegistry();
    register();
    lookups.length = 0;
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });
  test.each([android, ios])(
    "$platform refuses pager options expanded from components",
    async (device) => {
      const candidate = componentSpec();
      const result = prototypeOutputSchema.parse(
        readToolEnvelopePayload(await runSpec(device, candidate))?.payload,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        prototypePagerOptionsUnsupportedMessage(
          ["root.axis", "root.peek"],
          device.platform === "ios" ? "ios" : "android",
        ),
      );
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(agent.requests).toEqual([]);
    },
  );
  test.each([android, ios])(
    "$platform keeps component validation errors before pager refusal",
    async (device) => {
      const candidate = componentSpec();
      candidate.components.pageDeck.root.peek.start = -1;
      const result = prototypeOutputSchema.parse(
        readToolEnvelopePayload(await runSpec(device, candidate))?.payload,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("root (use pageDeck) → components.pageDeck.root.peek.start");
      expect(result.error).toContain("Invalid number value");
      expect(result.error).not.toContain(PROTOTYPE_PAGER_OPTIONS_CAPABILITY);
      expect(lookups).not.toContain(PROTOTYPE_PAGER_OPTIONS_CAPABILITY);
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(agent.requests).toEqual([]);
    },
  );
  test.each([android, ios])(
    "$platform refuses each explicit option on an unsupported device",
    async (device) => {
      for (const options of [
        { axis: "horizontal" },
        { pageSpacing: 0 },
        { peek: {} },
        { pageSize: "fill" },
      ]) {
        const root = { ...pager, ...options };
        const result = prototypeOutputSchema.parse(
          readToolEnvelopePayload(await run(device, root))?.payload,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          prototypePagerOptionsUnsupportedMessage(
            prototypePagerOptionFields(spec(root)),
            device.platform === "ios" ? "ios" : "android",
          ),
        );
      }
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(agent.requests).toEqual([]);
    },
  );
  test.each([android, ios])("$platform supported device shows options", async (device) => {
    client.setSupportedCommands([PROTOTYPE_PAGER_OPTIONS_CAPABILITY]);
    agent.handshake.capabilities.push(PROTOTYPE_PAGER_OPTIONS_CAPABILITY);
    const result = prototypeOutputSchema.parse(
      readToolEnvelopePayload(
        await run(device, {
          ...pager,
          axis: "vertical",
          peek: {},
          pageSpacing: 8,
          pageSize: { dp: 120 },
        }),
      )?.payload,
    );
    expect(result.success).toBe(true);
    expect(
      device.platform === "ios"
        ? agent.requests.filter((r) => r.type === "show_prototype").length
        : client.getPrototypeHistory().length,
    ).toBe(1);
  });
  test.each([android, ios])(
    "$platform plain pager never asks for pager capability",
    async (device) => {
      const iosLookup = spyOn(IosPrototypeTransport.prototype, "supportsCapability");
      try {
        const result = prototypeOutputSchema.parse(
          readToolEnvelopePayload(await run(device, pager))?.payload,
        );
        expect(result.success).toBe(true);
        expect(lookups).not.toContain(PROTOTYPE_PAGER_OPTIONS_CAPABILITY);
        expect(iosLookup.mock.calls.map(([capability]) => capability)).not.toContain(
          PROTOTYPE_PAGER_OPTIONS_CAPABILITY,
        );
      } finally {
        iosLookup.mockRestore();
      }
    },
  );
  test.each([false, true])(
    "abort during Android lookup stops show (supported=%s)",
    async (supported) => {
      const controller = new AbortController();
      const supports = client.supportsCommand.bind(client);
      client.supportsCommand = async (name) => {
        if (name === PROTOTYPE_PAGER_OPTIONS_CAPABILITY) {
          controller.abort(new Error("pager lookup cancelled"));
          return supported;
        }
        return supports(name);
      };
      await expect(run(android, { ...pager, peek: {} }, controller.signal)).rejects.toThrow(
        "pager lookup cancelled",
      );
      expect(client.getPrototypeHistory()).toEqual([]);
    },
  );
});
