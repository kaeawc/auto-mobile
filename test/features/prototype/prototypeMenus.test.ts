import { beforeAll, expect, test } from "bun:test";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { mapBindableFields } from "../../../src/features/prototype/prototypeTemplate";

const options = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
];
const menu = {
  type: "menu",
  openWhen: { key: "open", equals: true },
  items: [{ label: "Go" }, { type: "divider" }],
};
const select = { type: "select", stateKey: "choice", label: "Choice", options };
const spec = (root: unknown, state: unknown = { open: false, choice: "a" }) => ({
  id: "menus",
  window: { placement: { type: "fullscreen" } },
  state,
  root,
});
beforeAll(() => {
  prototypeSpecSchema.safeParse(spec({ type: "spacer" }));
});
test.each([menu, select])("accepts $type in both schemas", (node) => {
  expect(prototypeSpecSchema.safeParse(spec(node)).success).toBe(true);
  expect(validatePrototypeSpec(spec(node)).success).toBe(true);
});
test.each([
  { ...menu, items: [] },
  { ...menu, items: Array.from({ length: 17 }, () => ({ label: "x" })) },
  { ...menu, items: [{ type: "divider", label: "x" }] },
  { ...menu, items: [{ label: "" }] },
  { ...menu, items: [{ label: "x", extra: true }] },
  { ...menu, items: [{ label: "x", icon: "not_an_icon" }] },
  { ...menu, items: [{ label: "x", trailingText: "" }] },
  { ...menu, items: [{ label: "x", onTap: [] }] },
  { ...menu, openWhen: { key: "open", equals: "yes" } },
  { ...select, options: options.slice(0, 1) },
  { ...select, options: Array.from({ length: 33 }, (_, i) => ({ value: `${i}`, label: "x" })) },
  { ...select, label: "" },
  { ...select, options: [{ value: "", label: "A" }, options[1]] },
])("rejects malformed $type", (node) => {
  expect(prototypeSpecSchema.safeParse(spec(node)).success).toBe(false);
  expect(validatePrototypeSpec(spec(node)).success).toBe(false);
});
test.each([
  [select, { choice: 1 }, "root.stateKey", "Select requires a string state key"],
  [
    { ...select, options: [options[0], options[0]] },
    { choice: "a" },
    "root.options[1].value",
    "Duplicate select option value",
  ],
  [menu, { open: "yes" }, "root.openWhen.key", "Menu requires a boolean state key"],
  [
    { type: "radioGroup", stateKey: "choice", options },
    { choice: 1 },
    "root.stateKey",
    "Radio group requires a string state key",
  ],
  [
    { type: "dialog", openWhen: menu.openWhen, confirm: { label: "OK" } },
    { open: "yes" },
    "root.openWhen.key",
    "Dialog requires a boolean state key",
  ],
] as const)("pins semantic errors %#", (node, state, path, message) => {
  expect(validatePrototypeSpec(spec(node, state))).toEqual({
    success: false,
    error: { path, message },
  });
});
test("select accepts a string outside the options, matching radioGroup", () => {
  expect(validatePrototypeSpec(spec(select, { choice: "other" })).success).toBe(true);
});
test.each(["menu", "select"])("binds %s repeat fields without mutating the template", (type) => {
  const node =
    type === "menu"
      ? {
          ...menu,
          openWhen: { key: "{item.key}", equals: true },
          items: [
            {
              label: "{item.label}",
              trailingText: "{item.label}",
              onTap: [{ type: "setState", key: "{item.key}", value: false }],
            },
            { type: "divider" },
          ],
        }
      : {
          ...select,
          stateKey: "{item.key}",
          label: "{item.label}",
          options: [{ value: "a", label: "{item.label}" }, options[1]],
        };
  const mapped = mapBindableFields(node, "root", (value) =>
    value === "{item.key}" ? "bound" : value === "{item.label}" ? "Bound" : value,
  );
  expect(type === "menu" ? mapped.openWhen : mapped.stateKey).toEqual(
    type === "menu" ? { key: "bound", equals: true } : "bound",
  );
  expect(JSON.stringify(mapped)).not.toContain("{item.");
  expect(JSON.stringify(node)).toContain("{item.");
});
test.each(["menu", "select"])("expands use for %s labels, keys and actions", (type) => {
  const root =
    type === "menu"
      ? {
          ...menu,
          openWhen: { key: "{props.key}", equals: true },
          items: [
            {
              label: "{props.label}",
              trailingText: "{props.label}",
              onTap: [{ type: "setState", key: "{props.key}", value: false }],
            },
          ],
        }
      : {
          ...select,
          stateKey: "{props.key}",
          label: "{props.label}",
          options: [{ value: "a", label: "{props.label}" }, options[1]],
        };
  const candidate = {
    ...spec({
      type: "use",
      component: "control",
      props: { key: type === "menu" ? "open" : "choice", label: "Bound" },
    }),
    components: { control: { root } },
  };
  const result = validatePrototypeSpec(candidate);
  expect(result.success).toBe(true);
  expect(JSON.stringify(result)).not.toContain("{props.");
  expect(JSON.stringify(result)).toContain("Bound");
});

// Host capability checks use the same injected transports as data-model refusal tests.
import { afterEach, beforeEach } from "bun:test";
import { PROTOTYPE_MENUS_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import {
  prototypeMenuFields,
  prototypeMenusUnsupportedMessage,
} from "../../../src/features/prototype/prototypeData";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";
import type { BootedDevice } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { prototypeOutputSchema, registerPrototypeTools } from "../../../src/server/prototypeTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import {
  FakePrototypeAgentClient,
  FAKE_PROTOTYPE_AGENT_CAPABILITIES,
} from "../../fakes/FakePrototypeAgentClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakePrototypeAssetFileReader } from "../../fakes/FakePrototypeAssetFileReader";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { preserveToolRegistry } from "../../helpers/withTemporaryTool";

let client: FakeCtrlProxy;
let agent: FakePrototypeAgentClient;
let adb: FakeAdbExecutor;
let restore: () => void;
let unsubscribe: () => void;
beforeEach(() => {
  restore = preserveToolRegistry();
  const timer = new FakeTimer();
  client = new FakeCtrlProxy(timer);
  client.setSupportedCommands([]);
  agent = new FakePrototypeAgentClient({
    agentVersion: "0.1.0",
    protocolVersion: 1,
    capabilities: [...FAKE_PROTOTYPE_AGENT_CAPABILITIES],
  });
  adb = new FakeAdbExecutor();
  unsubscribe = registerPrototypeTools({
    clientFactory: () => client,
    agentConnections: { get: () => agent },
    adbFactory: new FakeAdbClientFactory(adb),
    assetFileReader: new FakePrototypeAssetFileReader(),
    lastRenderedObservation: () => undefined,
    clock: timer,
    timer,
    cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
  });
});
afterEach(() => {
  unsubscribe();
  restore();
});
test.each(["android", "ios"] as const)(
  "%s refuses both nodes before sending, then accepts with capability",
  async (platform) => {
    const device: BootedDevice = { deviceId: `fake-menus-${platform}`, platform, name: "Fake" };
    const handler = ToolRegistry.getTool("prototype")!.deviceAwareHandler!;
    for (const node of [menu, select]) {
      const candidate = spec(node);
      const response = await handler(device, {
        action: "show",
        spec: candidate,
        assets: [{ id: "unused", path: "/fake/unused.png" }],
      });
      expect(prototypeOutputSchema.parse(response.structuredContent)).toMatchObject({
        success: false,
        error: new ActionableError(prototypeMenusUnsupportedMessage(["root"], platform)).message,
      });
    }
    expect(client.getPrototypeHistory()).toEqual([]);
    expect(client.getPrototypeAssetHistory()).toEqual([]);
    expect(agent.requests).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
    client.setSupportedCommands([PROTOTYPE_MENUS_CAPABILITY]);
    agent.handshake.capabilities.push(PROTOTYPE_MENUS_CAPABILITY);
    for (const node of [menu, select]) {
      const response = await handler(device, { action: "show", spec: spec(node) });
      expect(prototypeOutputSchema.parse(response.structuredContent).success).toBe(true);
    }
  },
);
test.each(["android", "ios"] as const)("pins %s refusal wording", (platform) => {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  expect(prototypeMenusUnsupportedMessage(["root", "root.child"], platform)).toBe(
    `The ${device} does not advertise prototype_menus_v1, so it cannot render the menu or select at root (and 1 more). Nothing was shown. ${update}, or replace menu/select with buttons and radioGroup.`,
  );
});
test("only node positions require the menu capability", () => {
  expect(
    prototypeMenuFields(
      spec({
        type: "column",
        children: [
          menu,
          { type: "scroll", child: select },
          {
            type: "button",
            label: "Go",
            onTap: [{ type: "emit", name: "opaque", payload: { type: "menu" } }],
          },
        ],
      }),
    ),
  ).toEqual(["root.children[0]", "root.children[1].child"]);
});
test("iOS always reports in-window rendering for menu/select", () => {
  const parsed = prototypeSpecSchema.parse(spec({ type: "row", children: [menu, select] }));
  expect(prototypePlatformNotes(parsed, "ios", () => true)).toMatchObject([
    { construct: "menu", effect: "substituted", paths: ["root.children[0]"] },
    { construct: "select", effect: "substituted", paths: ["root.children[1]"] },
  ]);
  expect(prototypePlatformNotes(parsed, "android", () => true)).toEqual([]);
});
