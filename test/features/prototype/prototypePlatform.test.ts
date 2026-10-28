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
      Object.values(PROTOTYPE_PLATFORM_MODULES).flatMap((definition) => [
        definition.capability,
        ...(definition.deviceCapability ? [definition.deviceCapability] : []),
      ]),
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
        { type: "spacer", visibleWhen: { platform: pointer, equals: "compact" } },
      ),
    );

  test("is a production module with no calls and a debounced changed event", () => {
    expect(device.placeholder).toBeUndefined();
    expect(device.capability).toBe("prototype_platform_device_v1");
    expect(Object.keys(device.calls)).toEqual([]);
    expect(device.events.changed).toEqual({ sensitive: false, debounceMs: 250 });
    expect(prototypePlatformEventModule("device.changed")).toBe("device");
  });

  test("widthClass carries platform-native values under one key", () => {
    const state = device.state!;
    expect(state.widthClass?.platforms).toEqual(["android", "ios"]);
    expect(state.widthClass?.valueByPlatform?.ios).toEqual({
      kind: "enum",
      values: ["compact", "regular"],
    });
    expect(state.heightClass?.platforms).toEqual(["android"]);
    expect(state.posture?.platforms).toEqual(["android"]);
    expect(state.sizeClass).toBeUndefined();
    expect(state.widthClass?.breakpoints).toEqual([600, 840]);
    expect(state.heightClass?.breakpoints).toEqual([480, 900]);
    for (const key of ["os", "osVersion", "idiom", "windowWidth", "windowHeight", "pointer"]) {
      expect(state[key]?.platforms).toEqual(["android", "ios"]);
    }
  });

  test.each(["compact", "medium", "expanded", "regular"])(
    "portable widthClass comparison accepts %s",
    (value) => {
      for (const op of ["equals", "notEquals"]) {
        expect(
          validatePrototypeSpec(
            spec(
              { requires: { platform: ["device"] } },
              {
                type: "spacer",
                visibleWhen: { platform: "/device/widthClass", [op]: value },
              },
            ),
          ).success,
        ).toBe(true);
      }
    },
  );

  test.each(["wide", 1, null])("widthClass comparison refuses %p", (value) => {
    for (const op of ["equals", "notEquals"]) {
      expect(
        validatePrototypeSpec(
          spec(
            { requires: { platform: ["device"] } },
            {
              type: "spacer",
              visibleWhen: { platform: "/device/widthClass", [op]: value },
            },
          ),
        ).success,
      ).toBe(false);
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

describe("haptics and sound platform modules (#14329)", () => {
  const haptics = PROTOTYPE_PLATFORM_MODULES.haptics!;
  const sound = PROTOTYPE_PLATFORM_MODULES.sound!;
  const callSpec = (module: string, call: string, args: unknown) =>
    validatePrototypeSpec(
      spec(
        { requires: { platform: [module] } },
        { type: "button", label: "Go", onTap: [{ type: "platform", call, args }] },
      ),
    );

  test("are production call-only modules with their own capabilities", () => {
    for (const [module, capability, call] of [
      [haptics, "prototype_platform_haptics_v1", "perform"],
      [sound, "prototype_platform_sound_v1", "play"],
    ] as const) {
      expect(module.placeholder).toBeUndefined();
      expect(module.capability).toBe(capability);
      expect(Object.keys(module.calls)).toEqual([call]);
      expect(module.events).toEqual({});
      expect(module.state).toEqual({});
      expect(module.calls[call]?.permissions).toEqual([]);
      expect(module.calls[call]?.sensitive).toBe(false);
    }
  });

  test("the effect and sound lists are closed", () => {
    for (const effect of [
      "click",
      "tick",
      "heavyClick",
      "doubleClick",
      "selection",
      "success",
      "warning",
      "error",
      "impactLight",
      "impactMedium",
      "impactHeavy",
      "longPress",
    ]) {
      expect(callSpec("haptics", "haptics.perform", { effect: { value: effect } }).success).toBe(
        true,
      );
    }
    for (const name of ["click", "send", "receive", "shutter"]) {
      expect(callSpec("sound", "sound.play", { sound: { value: name } }).success).toBe(true);
    }
    expect(callSpec("haptics", "haptics.perform", { effect: { value: "buzz" } }).success).toBe(
      false,
    );
    expect(callSpec("sound", "sound.play", { sound: { value: "cheer" } }).success).toBe(false);
    // Audio asset ids wait for the audio asset type (#14254).
    expect(callSpec("sound", "sound.play", { sound: { asset: "ding" } }).success).toBe(false);
  });

  test("volume is a whole number from 0 to 100", () => {
    const volume = (value: number) =>
      callSpec("sound", "sound.play", { sound: { value: "click" }, volume: { value } }).success;
    expect([volume(0), volume(100)]).toEqual([true, true]);
    expect([volume(-1), volume(101), volume(50.5)]).toEqual([false, false, false]);
  });

  test("a use gates on the platform capability and its module capability", () => {
    const required = requiredPrototypeCapabilities(
      spec(
        { requires: { platform: ["haptics", "sound"] } },
        {
          type: "column",
          children: [
            {
              type: "button",
              label: "A",
              onTap: [
                { type: "platform", call: "haptics.perform", args: { effect: { value: "tick" } } },
              ],
            },
            {
              type: "button",
              label: "B",
              onTap: [{ type: "platform", call: "sound.play", args: { sound: { value: "send" } } }],
            },
          ],
        },
      ),
    );
    expect(required).toEqual(
      expect.arrayContaining([
        "prototype_platform_v1",
        "prototype_platform_haptics_v1",
        "prototype_platform_sound_v1",
      ]),
    );
  });

  test("no state is readable", () => {
    const result = validatePrototypeSpec(
      spec(
        { requires: { platform: ["haptics"] } },
        { type: "text", text: "{platform:/haptics/last}" },
      ),
    );
    expect(result.success).toBe(false);
  });
});

describe("device status module contract", () => {
  const values = (module: string, key: string): unknown =>
    PROTOTYPE_PLATFORM_MODULES[module]?.state?.[key]?.value.values;
  const keys = (module: string) => Object.keys(PROTOTYPE_PLATFORM_MODULES[module]?.state ?? {});

  test("each module exposes exactly its documented keys and one debounced changed event", () => {
    expect(keys("battery")).toEqual(["level", "state"]);
    expect(keys("power")).toEqual(["saver", "thermal"]);
    expect(keys("audio")).toEqual(["volume", "muted", "route", "ringer"]);
    expect(keys("connectivity")).toEqual(["online", "transport", "metered", "constrained"]);
    for (const module of ["battery", "power", "audio", "connectivity"]) {
      expect(Object.keys(PROTOTYPE_PLATFORM_MODULES[module].calls)).toEqual([]);
      expect(PROTOTYPE_PLATFORM_MODULES[module].events).toEqual({
        changed: { sensitive: false, debounceMs: 500 },
      });
    }
  });

  test("enum values are the documented sets", () => {
    expect(values("battery", "state")).toEqual(["charging", "full", "unplugged", "unknown"]);
    expect(values("power", "thermal")).toEqual(["nominal", "fair", "serious", "critical"]);
    expect(values("audio", "route")).toEqual([
      "speaker",
      "wired",
      "bluetooth",
      "usb",
      "airplay",
      "cast",
      "other",
    ]);
    expect(values("audio", "ringer")).toEqual(["normal", "vibrate", "silent"]);
    expect(values("connectivity", "transport")).toEqual([
      "wifi",
      "cellular",
      "ethernet",
      "vpn",
      "other",
      "none",
    ]);
  });

  test("the ringer is Android only", () => {
    expect(PROTOTYPE_PLATFORM_MODULES.audio.state?.ringer.platforms).toEqual(["android"]);
  });
});

describe("biometric module contract", () => {
  const biometric = PROTOTYPE_PLATFORM_MODULES.biometric;

  test("authenticate takes a bounded title, subtitle and an optional credential fallback", () => {
    const args = biometric.calls.authenticate.args;
    expect(Object.keys(args)).toEqual(["title", "subtitle", "allowDeviceCredential"]);
    expect(args.title.optional).toBe(false);
    expect(args.title.value.max).toBe(64);
    expect(args.subtitle.value.max).toBe(128);
    expect(args.allowDeviceCredential.optional).toBe(true);
  });

  test("a rejected attempt is an event, and the module has no state or permission", () => {
    expect(Object.keys(biometric.events)).toEqual(["attemptFailed"]);
    expect(biometric.state).toEqual({});
    expect(biometric.calls.authenticate.permissions).toEqual([]);
    expect(biometric.calls.authenticate.sensitive).toBe(false);
  });
});

describe("settings module contract", () => {
  const settings = PROTOTYPE_PLATFORM_MODULES.settings;

  test("open takes one page from the closed list and nothing else", () => {
    const args = settings.calls.open.args;
    expect(Object.keys(args)).toEqual(["page"]);
    expect(args.page.optional).toBe(false);
    expect(args.page.value.values).toEqual([
      "app",
      "notifications",
      "location",
      "wifi",
      "bluetooth",
      "display",
    ]);
  });

  test("the module has no events, state or permission", () => {
    expect(settings.events).toEqual({});
    expect(settings.state).toEqual({});
    expect(settings.calls.open.permissions).toEqual([]);
  });
});

describe("picker module contracts", () => {
  test("contacts.pick takes one optional boolean and is sensitive", () => {
    const pick = PROTOTYPE_PLATFORM_MODULES.contacts.calls.pick;
    expect(Object.keys(pick.args)).toEqual(["multiple"]);
    expect(pick.args.multiple.optional).toBe(true);
    expect(pick.sensitive).toBe(true);
    expect(pick.permissions).toEqual([]);
  });

  test("calendar.insert bounds its text and requires title, start and end", () => {
    const insert = PROTOTYPE_PLATFORM_MODULES.calendar.calls.insert;
    expect(Object.keys(insert.args)).toEqual([
      "title",
      "start",
      "end",
      "allDay",
      "location",
      "notes",
    ]);
    const required = Object.entries(insert.args)
      .filter(([, argument]) => !argument.optional)
      .map(([name]) => name);
    expect(required).toEqual(["title", "start", "end"]);
    expect(insert.args.title.value.max).toBe(256);
    expect(insert.args.location.value.max).toBe(256);
    expect(insert.args.notes.value.max).toBe(2048);
    expect(insert.args.start.value.integer).toBe(true);
    expect(insert.sensitive).toBe(false);
  });

  test("neither picker module has events, state or a declared permission", () => {
    for (const name of ["contacts", "calendar"]) {
      expect(PROTOTYPE_PLATFORM_MODULES[name].events).toEqual({});
      expect(PROTOTYPE_PLATFORM_MODULES[name].state).toEqual({});
    }
  });
});

describe("links module contract", () => {
  const open = PROTOTYPE_PLATFORM_MODULES.links.calls.open;
  const allowed = new RegExp(contract.patterns.openUrl);

  test("open takes a bounded url and an optional mode from the closed list", () => {
    expect(Object.keys(open.args)).toEqual(["url", "mode"]);
    expect(open.args.url.optional).toBe(false);
    expect(open.args.url.value.max).toBe(2048);
    expect(open.args.url.value.pattern).toBe("openUrl");
    expect(open.args.mode.value.values).toEqual(["external", "inApp", "auto"]);
  });

  test("the scheme allowlist accepts web, mail, phone, sms and map links", () => {
    for (const url of [
      "https://example.com/a?b=1",
      "http://example.com",
      "mailto:ada@example.test?subject=Hi%20there",
      "tel:+15551234567",
      "sms:+15551234567",
      "geo:37.78,-122.41",
      "maps://?q=coffee",
      "https://example.com/{id}",
    ]) {
      expect(allowed.test(url)).toBe(true);
    }
  });

  test("the scheme allowlist refuses component, local and script schemes", () => {
    for (const url of [
      "intent://scan/#Intent;scheme=zxing;end",
      "file:///etc/passwd",
      "content://com.android.contacts/contacts",
      "javascript:alert(1)",
      "data:text/html,hello",
      "myapp://open",
      "HTTPS://example.com",
      "example.com",
      "https://example.com/a b",
      "https://example.com/\u0000",
      "https:",
    ]) {
      expect(allowed.test(url)).toBe(false);
    }
  });
});

describe("system media picker and camera module contracts", () => {
  const pick = PROTOTYPE_PLATFORM_MODULES.mediaLibrary.calls.pick;
  const capture = PROTOTYPE_PLATFORM_MODULES.camera.calls.capture;

  test("mediaLibrary.pick requires a media kind and bounds maxItems to 1-64", () => {
    expect(Object.keys(pick.args)).toEqual(["media", "maxItems"]);
    expect(pick.args.media.optional).toBe(false);
    expect(pick.args.media.value.values).toEqual(["images", "videos", "imagesAndVideos"]);
    expect(pick.args.maxItems.optional).toBe(true);
    expect(pick.args.maxItems.value).toEqual({ kind: "number", integer: true, min: 1, max: 64 });
  });

  test("camera.capture requires a media kind and takes an optional video duration", () => {
    expect(Object.keys(capture.args)).toEqual(["media", "maxDurationMs"]);
    expect(capture.args.media.value.values).toEqual(["image", "video"]);
    expect(capture.args.maxDurationMs.optional).toBe(true);
    expect(capture.args.maxDurationMs.value.integer).toBe(true);
    expect(capture.args.maxDurationMs.value.min).toBe(1);
  });

  test("both use system UI: sensitive, no declared permission, events or state", () => {
    for (const call of [pick, capture]) {
      expect(call.sensitive).toBe(true);
      expect(call.permissions).toEqual([]);
      expect(call.background).toEqual([]);
    }
    for (const name of ["mediaLibrary", "camera"]) {
      expect(PROTOTYPE_PLATFORM_MODULES[name].events).toEqual({});
      expect(PROTOTYPE_PLATFORM_MODULES[name].state).toEqual({});
    }
  });

  test("picker and capture are gated separately, so a device can offer only the picker", () => {
    expect(PROTOTYPE_PLATFORM_MODULES.mediaLibrary.capability).toBe(
      "prototype_platform_mediaLibrary_v1",
    );
    expect(PROTOTYPE_PLATFORM_MODULES.camera.capability).toBe("prototype_platform_camera_v1");
  });
});

describe("auth module contract", () => {
  const auth = PROTOTYPE_PLATFORM_MODULES.auth;

  test("auth.signIn takes only an optional style and auth.signOut takes nothing", () => {
    expect(Object.keys(auth.calls)).toEqual(["signIn", "signOut"]);
    expect(Object.keys(auth.calls.signIn.args)).toEqual(["style"]);
    expect(auth.calls.signIn.args.style.optional).toBe(true);
    expect(auth.calls.signIn.args.style.value.values).toEqual(["chooser", "button"]);
    expect(auth.calls.signIn.sensitive).toBe(true);
    expect(auth.calls.signOut.args).toEqual({});
    for (const call of Object.values(auth.calls)) {
      expect(call.permissions).toEqual([]);
    }
  });

  test("the session is visible only as signedIn and userId, never a token", () => {
    expect(auth.events).toEqual({ sessionExpired: { sensitive: false } });
    expect(Object.keys(auth.state ?? {})).toEqual(["signedIn", "userId"]);
  });
});

describe("location module contract", () => {
  const location = PROTOTYPE_PLATFORM_MODULES.location;

  test("location.request takes optional accuracy and maxAgeMs and needs the location permission", () => {
    const request = location.calls.request;
    expect(Object.keys(request.args)).toEqual(["accuracy", "maxAgeMs"]);
    expect(Object.values(request.args).every((argument) => argument.optional)).toBe(true);
    expect(request.args.accuracy.value.values).toEqual(["precise", "approximate"]);
    expect(request.args.maxAgeMs.value.integer).toBe(true);
    expect(request.args.maxAgeMs.value.min).toBe(0);
    expect(request.permissions).toEqual(["location"]);
    expect(request.background).toEqual([]);
    expect(request.sensitive).toBe(true);
  });

  test("location.updated is sensitive and the state is the current fix and the services toggle", () => {
    expect(location.events).toEqual({ updated: { sensitive: true } });
    expect(Object.keys(location.state ?? {})).toEqual(["current", "servicesEnabled"]);
    expect(location.state?.current.value.kind).toBe("json");
    expect(location.state?.servicesEnabled.value.kind).toBe("boolean");
  });
});

describe("sensors module contract", () => {
  const sensors = PROTOTYPE_PLATFORM_MODULES.sensors;

  test("sensors has no calls and one shake event", () => {
    expect(sensors.calls).toEqual({});
    expect(sensors.events).toEqual({ shake: { sensitive: false } });
  });

  test("continuous readings are flat whole-number keys and light is Android only", () => {
    const state = sensors.state ?? {};
    expect(Object.keys(state)).toEqual([
      "pitchDeg",
      "rollDeg",
      "headingDeg",
      "steps",
      "proximityNear",
      "lightLux",
    ]);
    for (const name of ["pitchDeg", "rollDeg", "headingDeg", "steps", "lightLux"]) {
      expect(state[name].value.integer).toBe(true);
    }
    expect(state.headingDeg.value.max).toBe(359);
    expect(state.proximityNear.value.kind).toBe("boolean");
    expect(state.lightLux.platforms).toEqual(["android"]);
    expect(state.steps.platforms).toEqual(["android", "ios"]);
  });
});
