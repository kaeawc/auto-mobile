import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { decodePrototypeEvent } from "../../../src/features/observe/android/CtrlProxyPrototypes";
import { PROTOTYPE_PLATFORM_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME,
  PROTOTYPE_PLATFORM_EVENT_NAME,
  PROTOTYPE_PLATFORM_MODULE_GATES,
  PROTOTYPE_PLATFORM_MODULES,
  prototypePlatformCall,
  prototypePlatformEventModule,
  prototypePlatformFields,
  prototypePlatformModuleFields,
  prototypePlatformPointerModule,
  prototypePlatformUnsupportedMessage,
} from "../../../src/features/prototype/prototypePlatform";
import {
  prototypePlatformCallEventOf,
  prototypePlatformDeliveredEventOf,
} from "../../../src/features/prototype/prototypePlatformEvent";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const window = { placement: { type: "fullscreen" } };
const echo = { type: "platform", call: "test.echo", args: { message: { value: "hi" } } };
const spec = (extra: Record<string, unknown>, root: unknown = { type: "spacer" }) => ({
  id: "p",
  window,
  ...extra,
  root,
});

describe("platform module table", () => {
  test("resolves calls, events and pointer modules from the contract", () => {
    expect(prototypePlatformCall("test.echo")?.definition.args.message?.optional).toBe(false);
    expect(prototypePlatformCall("test.missing")).toBeUndefined();
    expect(prototypePlatformCall("nope.echo")).toBeUndefined();
    expect(prototypePlatformCall("test")).toBeUndefined();
    expect(prototypePlatformCall(".echo")).toBeUndefined();
    expect(prototypePlatformEventModule("test.tick")).toBe("test");
    expect(prototypePlatformEventModule("test.echo")).toBeUndefined();
    expect(prototypePlatformPointerModule("/test/count")).toBe("test");
    expect(prototypePlatformPointerModule("/a~1b/c")).toBe("a/b");
  });

  test("the placeholder module is never advertised by a production runtime", () => {
    expect(PROTOTYPE_PLATFORM_MODULES.test?.placeholder).toBe(true);
    expect(PROTOTYPE_PLATFORM_MODULES.test?.capability).toBe("prototype_platform_test_v1");
  });

  test("every module capability follows the prototype_platform_<module>_vN form", () => {
    for (const [name, definition] of Object.entries(contract.platformModules)) {
      expect(definition.capability).toMatch(new RegExp(`^prototype_platform_${name}_v[0-9]+$`));
    }
    expect(PROTOTYPE_PLATFORM_MODULE_GATES.map((gate) => gate.capability)).toEqual(
      Object.values(contract.platformModules).map((definition) => definition.capability),
    );
  });
});

describe("platform validation", () => {
  test("handlers may read {event}, calls may read {platform}", () => {
    const result = validatePrototypeSpec(
      spec(
        {
          requires: { platform: ["test"] },
          data: { last: {} },
          platform: {
            on: {
              "test.tick": [{ ...echo, args: { message: { event: "/n" } }, into: "/data/last" }],
            },
          },
        },
        {
          type: "button",
          label: "Go",
          onTap: [{ ...echo, args: { message: { platform: "/test/n" } } }],
        },
      ),
    );
    expect(result.success).toBe(true);
  });

  test("a follow-up inside a handler still sees {event}", () => {
    const nested = {
      ...echo,
      onSuccess: [{ ...echo, args: { message: { event: "/n" } } }],
    };
    expect(
      validatePrototypeSpec(
        spec({ requires: { platform: ["test"] }, platform: { on: { "test.tick": [nested] } } }),
      ).success,
    ).toBe(true);
  });

  test("a follow-up outside a handler cannot read {event}", () => {
    const nested = { ...echo, onSuccess: [{ ...echo, args: { message: { event: "/n" } } }] };
    expect(
      validatePrototypeSpec(
        spec(
          { requires: { platform: ["test"] } },
          { type: "button", label: "Go", onTap: [nested] },
        ),
      ),
    ).toEqual({
      success: false,
      error: {
        path: "root.onTap[0].onSuccess[0].args.message.event",
        message: "{event} is only available inside a platform.on handler",
      },
    });
  });

  test("a {value} literal holding platform-shaped JSON is opaque", () => {
    const literal = { ...echo, args: { message: { value: { platform: "/nope/x" } } } };
    expect(
      validatePrototypeSpec(
        spec(
          { requires: { platform: ["test"] } },
          { type: "button", label: "Go", onTap: [literal] },
        ),
      ).success,
    ).toBe(true);
  });

  test("an emit payload naming platform is opaque", () => {
    const emit = { type: "emit", name: "x", payload: { platform: "/nope/x", event: "/y" } };
    expect(
      validatePrototypeSpec(spec({}, { type: "button", label: "Go", onTap: [emit] })).success,
    ).toBe(true);
  });

  test("a platform condition inside a repeat item list stays data", () => {
    const repeated = {
      type: "column",
      repeat: { items: [{ platform: "ios" }], as: "item" },
      children: [{ type: "text", text: "{item.platform}" }],
    };
    expect(validatePrototypeSpec(spec({}, repeated)).success).toBe(true);
  });

  test("the request reserved name keeps its own message", () => {
    const result = validatePrototypeSpec(
      spec(
        {},
        { type: "button", label: "Go", onTap: [{ type: "emit", name: "prototype_request" }] },
      ),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        "The emit name prototype_request is reserved for request events",
      );
    }
  });

  test("an action nesting past MAX_PROTOTYPE_ACTION_DEPTH is refused", () => {
    let action: Record<string, unknown> = echo;
    for (let depth = 1; depth <= contract.limits.MAX_PROTOTYPE_ACTION_DEPTH; depth++) {
      action = { ...echo, onSuccess: [action] };
    }
    const result = validatePrototypeSpec(
      spec({ requires: { platform: ["test"] } }, { type: "button", label: "Go", onTap: [action] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe("Action nesting limit exceeded");
    }
  });
});

describe("platform capability gates", () => {
  const used = spec(
    { requires: { platform: ["test"] }, platform: { on: { "test.tick": [{ type: "dismiss" }] } } },
    { type: "text", text: "{platform:/test/n}", visibleWhen: { platform: "/test/n", gt: 1 } },
  );

  test("the vocabulary gate reports every construct, the module gate its own uses", () => {
    expect(prototypePlatformFields(used)).toEqual([
      "requires",
      "requires.platform[0]",
      "platform",
      'platform.on["test.tick"]',
      "root.visibleWhen.platform",
      "root.text",
    ]);
    expect(prototypePlatformModuleFields(used, "test")).toEqual([
      "requires.platform[0]",
      'platform.on["test.tick"]',
      "root.visibleWhen.platform",
      "root.text",
    ]);
    expect(requiredPrototypeCapabilities(used)).toEqual([
      "prototype_platform_test_v1",
      PROTOTYPE_PLATFORM_CAPABILITY,
    ]);
  });

  test("a permission-only requires needs the vocabulary gate alone", () => {
    expect(
      requiredPrototypeCapabilities(
        spec({ requires: { permissions: [{ name: "camera", purpose: "Scan" }] } }),
      ),
    ).toEqual([PROTOTYPE_PLATFORM_CAPABILITY]);
  });

  test("a call inside a component definition is located at its definition", () => {
    const withComponent = {
      ...spec({ requires: { platform: ["test"] } }),
      components: { Echo: { root: { type: "button", label: "Go", onTap: [echo] } } },
    };
    expect(prototypePlatformModuleFields(withComponent, "test")).toContain(
      "components.Echo.root.onTap[0]",
    );
  });

  test("the refusal names the capability, the first field and the remaining count", () => {
    expect(prototypePlatformUnsupportedMessage(["requires", "platform"], "android")).toBe(
      "The connected CtrlProxy does not advertise prototype_platform_v1, so it cannot run the platform vocabulary at requires (and 1 more). Nothing was shown. Update the connected CtrlProxy, or use a spec without it.",
    );
    const gate = PROTOTYPE_PLATFORM_MODULE_GATES[0]!;
    expect(gate.unsupportedMessage(["root.onTap[0]"], "ios")).toContain(
      "connected iOS prototype agent does not advertise prototype_platform_test_v1, so it cannot run the test platform module at root.onTap[0].",
    );
  });

  test("specs without the vocabulary need no platform gate", () => {
    expect(prototypePlatformFields(spec({}, { type: "text", text: "{data:/x}" }))).toEqual([]);
  });
});

// Frames cross the wire as JSON, so undefined members cannot be present.
const decode = (frame: unknown) =>
  decodePrototypeEvent(JSON.parse(JSON.stringify(frame ?? null)), "test");
const frame = (name: string, payload: unknown) => ({
  type: "prototype_event",
  timestamp: 1,
  id: "p",
  sequence: 1,
  kind: "emit",
  name,
  payload,
  state: {},
  pages: {},
});

describe("platform events", () => {
  const finished = { callId: "c-1", call: "test.echo", outcome: "success", durationMs: 4 };

  test("decodes a finished call and its typed error", () => {
    expect<unknown>(
      prototypePlatformCallEventOf(decode(frame(PROTOTYPE_PLATFORM_EVENT_NAME, finished))!),
    ).toEqual(finished);
    const failed = {
      ...finished,
      outcome: "error",
      error: { code: "permission_denied", message: "Camera denied" },
      simulated: true,
    };
    expect(
      prototypePlatformCallEventOf(decode(frame(PROTOTYPE_PLATFORM_EVENT_NAME, failed))!)?.error
        ?.code,
    ).toBe("permission_denied");
  });

  test("decodes a delivered event with truncated data", () => {
    const delivered = { event: "test.tick", data: { n: 1 }, truncated: true };
    expect<unknown>(
      prototypePlatformDeliveredEventOf(
        decode(frame(PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME, delivered))!,
      ),
    ).toEqual(delivered);
  });

  test.each([
    [PROTOTYPE_PLATFORM_EVENT_NAME, { ...finished, outcome: "error" }],
    [PROTOTYPE_PLATFORM_EVENT_NAME, { ...finished, error: { code: "timeout", message: "m" } }],
    [PROTOTYPE_PLATFORM_EVENT_NAME, { ...finished, call: "echo" }],
    [PROTOTYPE_PLATFORM_EVENT_NAME, { ...finished, extra: 1 }],
    [
      PROTOTYPE_PLATFORM_EVENT_NAME,
      { ...finished, outcome: "error", error: { code: "oops", message: "m" } },
    ],
    [PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME, { event: "test.tick" }],
    [PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME, { event: "tick", data: 1 }],
  ])("drops a malformed %s payload %p", (name, payload) => {
    expect(decode(frame(name, payload))).toBeUndefined();
  });

  test("other emits are not platform events", () => {
    const event = decode(frame("tapped", finished))!;
    expect(prototypePlatformCallEventOf(event)).toBeUndefined();
    expect(prototypePlatformDeliveredEventOf(event)).toBeUndefined();
  });
});

describe("device platform module", () => {
  const device = PROTOTYPE_PLATFORM_MODULES.device!;
  const read = (pointer: string, requires: string[] = ["device"]) =>
    validatePrototypeSpec(
      spec(
        { requires: { platform: requires } },
        { type: "spacer", visibleWhen: { platform: pointer, equals: "x" } },
      ),
    );

  test("is a production module with no calls and a debounced changed event", () => {
    expect(device.placeholder).toBeUndefined();
    expect(device.capability).toBe("prototype_platform_device_v1");
    expect(Object.keys(device.calls)).toEqual([]);
    expect(device.events.changed).toEqual({ sensitive: false, debounceMs: 250 });
    expect(prototypePlatformEventModule("device.changed")).toBe("device");
  });

  test("width classes are Android-only and the raw size class is iOS-only", () => {
    const state = device.state!;
    expect(state.widthClass?.platforms).toEqual(["android"]);
    expect(state.heightClass?.platforms).toEqual(["android"]);
    expect(state.posture?.platforms).toEqual(["android"]);
    expect(state.sizeClass?.platforms).toEqual(["ios"]);
    expect(state.widthClass?.breakpoints).toEqual([600, 840]);
    expect(state.heightClass?.breakpoints).toEqual([480, 900]);
    for (const key of ["os", "osVersion", "idiom", "windowWidth", "windowHeight", "pointer"]) {
      expect(state[key]?.platforms).toEqual(["android", "ios"]);
    }
  });

  test("every state key reads", () => {
    for (const key of Object.keys(device.state!)) {
      expect(read(`/device/${key}`).success).toBe(true);
    }
  });

  test("a pointer that is not exactly one state key is refused", () => {
    for (const pointer of ["/device/orientation", "/device/widthClass/x", "/device"]) {
      const result = read(pointer);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          path: "root.visibleWhen.platform",
          message: `Unknown platform state ${pointer}`,
        });
      }
    }
  });

  test("a read without requires.platform names the module", () => {
    const result = read("/device/widthClass", []);
    expect(result.success).toBe(false);
  });

  test("the placeholder module still accepts any pointer", () => {
    expect(
      validatePrototypeSpec(
        spec(
          { requires: { platform: ["test"] } },
          { type: "text", text: "{platform:/test/a/b/c}" },
        ),
      ).success,
    ).toBe(true);
  });

  test("a device read needs prototype_platform_device_v1 and the vocabulary gate", () => {
    const used = spec(
      { requires: { platform: ["device"] } },
      { type: "text", text: "{platform:/device/os}" },
    );
    expect(requiredPrototypeCapabilities(used)).toEqual([
      "prototype_platform_device_v1",
      PROTOTYPE_PLATFORM_CAPABILITY,
    ]);
  });
});
