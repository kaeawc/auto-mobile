import { beforeAll, describe, expect, test } from "bun:test";
import {
  prototypeSpecSchema,
  MAX_PROTOTYPE_TEXT_SPANS,
} from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  bindNodeFields,
  mapBindableFields,
} from "../../../src/features/prototype/prototypeTemplate";
import { expandPrototypeComponents } from "../../../src/features/prototype/prototypeComponents";
import {
  prototypeDataModelFields,
  prototypeDataPlaceholders,
  resolvePrototypeDataPointer,
} from "../../../src/features/prototype/prototypeData";
import {
  prototypeRichTextFields,
  prototypeRichTextUnsupportedMessage,
} from "../../../src/features/prototype/prototypeRichText";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";
import { PROTOTYPE_RICH_TEXT_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { prototypeOutputSchema, registerPrototypeTools } from "../../../src/server/prototypeTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import {
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
  FakePrototypeAgentClient,
} from "../../fakes/FakePrototypeAgentClient";
import { FakePrototypeAssetFileReader } from "../../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../../fakes/FakeTimer";
import { preserveToolRegistry } from "../../helpers/withTemporaryTool";

const spec = (root: unknown) => ({
  id: "rich",
  window: { placement: { type: "fullscreen" } },
  root,
});
const rich = spec({
  type: "text",
  spans: [{ text: "Terms", onTap: [{ type: "emit", name: "terms" }] }],
});
beforeAll(() => {
  validatePrototypeSpec(rich);
});

describe("rich text schema", () => {
  test.each(["", " ", "{name}"])("plain text %j is unchanged", (text) => {
    expect(validatePrototypeSpec(spec({ type: "text", text })).success).toBe(true);
    expect(prototypeRichTextFields(spec({ type: "text", text }))).toEqual([]);
  });
  test("whitespace is a nonempty span and style shares node ranges", () => {
    expect(MAX_PROTOTYPE_TEXT_SPANS).toBe(64);
    expect(
      validatePrototypeSpec(
        spec({
          type: "text",
          spans: [
            {
              text: " ",
              style: {
                fontWeight: 100,
                textSize: 0.01,
                letterSpacing: -2,
                fontFamily: { asset: "font" },
                color: { light: "primary", dark: "#FFFFFF" },
                background: "surface",
              },
            },
          ],
        }),
      ).success,
    ).toBe(true);
  });
  test.each(["testTag", "visibleWhen", "styleWhen", "spans", "url"])("span refuses %s", (key) => {
    const candidate = spec({ type: "text", spans: [{ text: "x", [key]: "x" }] });
    expect(validatePrototypeSpec(candidate)).toMatchObject({
      success: false,
      error: { path: `root.spans[0].${key}`, message: "Unknown property" },
    });
    expect(prototypeSpecSchema.safeParse(candidate).success).toBe(false);
  });
  test.each([{ onTap: [] }, { onTap: Array.from({ length: 33 }, () => ({ type: "dismiss" })) }])(
    "span actions keep node count bounds",
    ({ onTap }) => {
      expect(
        validatePrototypeSpec(spec({ type: "text", spans: [{ text: "x", onTap }] })),
      ).toMatchObject({
        success: false,
        error: { path: "root.spans[0].onTap", message: "Array length out of range" },
      });
    },
  );
  test.each([{ type: "text" }, { type: "text", text: "", spans: [{ text: "x" }] }])(
    "Zod enforces exclusive text form",
    (root) => {
      expect(prototypeSpecSchema.safeParse(spec(root)).success).toBe(false);
    },
  );
  test("span actions participate in state type validation", () => {
    expect(
      validatePrototypeSpec(
        spec({ type: "text", spans: [{ text: "x", onTap: [{ type: "toggle", key: "missing" }] }] }),
      ),
    ).toMatchObject({ success: false, error: { path: "root.spans[0].onTap[0].key" } });
  });
});

test("span text and actions use the repeat binder, preserving state and data placeholders", () => {
  const node = {
    type: "text",
    spans: [
      {
        text: "{item.title}/{index}/{name}/{data:/title}",
        onTap: [
          { type: "emit", name: "open_{item.title}" },
          { type: "setState", key: "picked_{index}", value: "{item.id}" },
        ],
      },
    ],
  };
  expect(
    bindNodeFields(node, "root", {
      binding: { alias: "item", index: true },
      values: { title: "Tea", id: 7 },
      index: 2,
    }),
  ).toEqual({
    type: "text",
    spans: [
      {
        text: "Tea/2/{name}/{data:/title}",
        onTap: [
          { type: "emit", name: "open_Tea" },
          { type: "setState", key: "picked_2", value: 7 },
        ],
      },
    ],
  });
});

test("span text is visited as node text for state and data binding", () => {
  const node = { type: "text", spans: [{ text: "{name}" }, { text: "{data:/title}" }] };
  const visited: string[] = [];
  expect(
    mapBindableFields(node, "root", (value, path, kind) => {
      visited.push(path);
      if (kind !== "text" || typeof value !== "string") {
        return value;
      }
      if (value === "{name}") {
        return "Ada";
      }
      return resolvePrototypeDataPointer({ title: "Tea" }, prototypeDataPlaceholders(value)[0]);
    }),
  ).toEqual({ type: "text", spans: [{ text: "Ada" }, { text: "Tea" }] });
  expect(visited).toEqual(["root.spans[0].text", "root.spans[1].text"]);
  expect(prototypeDataModelFields(spec(node))).toEqual(["root.spans[1].text"]);
  expect(node.spans[0].text).toBe("{name}");
});

test("component props bind span text and actions", () => {
  const source = {
    ...spec({ type: "use", component: "link", props: { title: "Terms", event: "terms" } }),
    components: {
      link: {
        root: {
          type: "text",
          spans: [{ text: "{props.title}", onTap: [{ type: "emit", name: "{props.event}" }] }],
        },
      },
    },
  };
  expect(expandPrototypeComponents(source)).toMatchObject({ success: true, spec: rich });
});

test("capability walker includes components, repeat templates, slots and patch nodes without opaque payloads", () => {
  const node = { type: "text", spans: [{ text: "x" }] };
  expect(
    prototypeRichTextFields({
      components: { label: { root: node } },
      root: {
        type: "column",
        repeat: { items: [{ payload: node }] },
        children: [node],
        child: node,
      },
      ops: [{ op: "replaceNode", node }],
      data: node,
      state: node,
      payload: node,
    }),
  ).toEqual([
    "components.label.root.spans",
    "root.children[0].spans",
    "root.child.spans",
    "ops[0].node.spans",
  ]);
  for (const platform of ["android", "ios"] as const) {
    expect(prototypeRichTextUnsupportedMessage(["root.spans"], platform)).toContain("root.spans");
    expect(prototypeRichTextUnsupportedMessage(["root.spans"], platform)).toContain(
      PROTOTYPE_RICH_TEXT_CAPABILITY,
    );
  }
});

test("iOS link note is unconditional for tappable spans, capped in the existing shape", () => {
  const result = validatePrototypeSpec(rich);
  if (!result.success) {
    throw Error(result.error.message);
  }
  expect(prototypePlatformNotes(result.data, "android", () => false)).toEqual([]);
  expect(prototypePlatformNotes(result.data, "ios", () => true)).toEqual([
    {
      platform: "ios",
      construct: "rich-text-links",
      effect: "substituted",
      paths: ["root.spans[0].onTap"],
      detail:
        "Tappable text spans render as links; the agent does not expose them as separate accessibility elements or semantic links. Use tapAt on the span.",
    },
  ]);
  const plain = validatePrototypeSpec(spec({ type: "text", spans: [{ text: "x" }] }));
  expect(plain.success && prototypePlatformNotes(plain.data, "ios", () => true)).toEqual([]);
});

test("iOS link notes use the existing path cap and total", () => {
  const result = validatePrototypeSpec(
    spec({
      type: "text",
      spans: Array.from({ length: 21 }, () => ({
        text: "Terms",
        onTap: [{ type: "emit", name: "terms" }],
      })),
    }),
  );
  if (!result.success) {
    throw Error(result.error.message);
  }
  const notes = prototypePlatformNotes(result.data, "ios", () => true);
  expect(notes[0].paths).toHaveLength(20);
  expect(notes[0].total).toBe(21);
});

test.each(["android", "ios"] as const)(
  "%s capability refusal happens before sending; supported and plain shows pass",
  async (platform) => {
    const restore = preserveToolRegistry();
    const timer = new FakeTimer();
    const client = new FakeCtrlProxy(timer);
    client.setSupportedCommands([]);
    const agent = new FakePrototypeAgentClient({
      agentVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES],
    });
    const unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      agentConnections: { get: () => agent },
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      assetFileReader: new FakePrototypeAssetFileReader(),
      lastRenderedObservation: () => undefined,
      clock: timer,
      timer,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
    });
    const device = { deviceId: "fake-rich", platform, name: "Fake" };
    async function show(value: unknown) {
      const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, {
        action: "show",
        spec: value,
      });
      return prototypeOutputSchema.parse(response.structuredContent);
    }
    try {
      const refused = await show(rich);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain("root.spans");
      expect(refused.error).toContain(PROTOTYPE_RICH_TEXT_CAPABILITY);
      expect(client.getPrototypeHistory()).toEqual([]);
      expect(agent.requests).toEqual([]);
      expect((await show(spec({ type: "text", text: "" }))).success).toBe(true);
      client.setSupportedCommands([PROTOTYPE_RICH_TEXT_CAPABILITY]);
      agent.handshake.capabilities.push(PROTOTYPE_RICH_TEXT_CAPABILITY);
      expect((await show(rich)).success).toBe(true);
    } finally {
      unsubscribe();
      restore();
    }
  },
);
