import { describe, expect, test } from "bun:test";
import shareSpec from "../../fixtures/prototype-spec/valid/share-text.json";
import {
  loadPrototypePlatformModules,
  PROTOTYPE_PLATFORM_MODULES,
  prototypePlatformError,
  prototypePlatformUses,
} from "../../../src/features/prototype/prototypePlatform";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const share = shareSpec.root.onTap[0];
const spec = (root: unknown) => ({ ...shareSpec, root });
const message =
  "Side-effecting platform call share.open needs a user gesture: move it into onTap, onLongPress, onDoubleTap or onSubmit";
const refused = (input: unknown, path: string) =>
  expect(validatePrototypeSpec(input)).toEqual({ success: false, error: { path, message } });
const request = (followUp: string) => ({
  type: "request",
  url: "https://example.com/",
  [followUp]: [share],
});

describe("side-effecting calls need a user gesture", () => {
  test("a button onTap allows a share", () => {
    expect(
      validatePrototypeSpec(spec({ type: "button", label: "Share", onTap: [share] })).success,
    ).toBe(true);
  });

  test("a topAppBar action onTap allows a share", () => {
    expect(
      validatePrototypeSpec(
        spec({
          type: "topAppBar",
          title: "Share",
          actions: [{ icon: "share", label: "Share", onTap: [share] }],
        }),
      ).success,
    ).toBe(true);
  });

  test("a dialog confirm onTap allows a share", () => {
    expect(
      validatePrototypeSpec({
        ...spec({
          type: "dialog",
          openWhen: { key: "open", equals: true },
          confirm: { label: "Share", onTap: [share] },
        }),
        state: { open: true },
      }).success,
    ).toBe(true);
  });

  test("a topAppBar action onAppear refuses a share at its action path", () => {
    // The contract rejects this owner handler; also pin the scanner's gesture policy.
    expect(
      prototypePlatformError(
        spec({
          type: "topAppBar",
          title: "Share",
          actions: [{ icon: "share", label: "Share", onAppear: [share] }],
        }),
        [],
        () => undefined,
      ),
    ).toEqual({ path: "root.actions[0].onAppear[0]", message });
  });

  test("a nested owner's onTap cannot regain a gesture under onAppear", () => {
    // This shape is outside the contract, so exercise the policy seam directly.
    expect(
      prototypePlatformError(
        spec({
          type: "text",
          text: "Share",
          onAppear: [{ onTap: [share] }],
        }),
        [],
        () => undefined,
      ),
    ).toEqual({ path: "root.onAppear[0].onTap[0]", message });
  });

  test("a nested owner's onTap cannot regain a gesture under a timer", () => {
    expect(
      prototypePlatformError(
        spec({
          type: "button",
          label: "Share",
          onTap: [{ type: "startTimer", id: "tick", afterMs: 100, actions: [{ onTap: [share] }] }],
        }),
        [],
        () => undefined,
      ),
    ).toEqual({ path: "root.onTap[0].actions[0].onTap[0]", message });
  });

  test("onAppear refuses a share at its action path", () => {
    refused(spec({ type: "text", text: "Hi", onAppear: [share] }), "root.onAppear[0]");
  });

  test("a timer started by a tap loses the gesture", () => {
    refused(
      spec({
        type: "button",
        label: "Go",
        onTap: [{ type: "startTimer", id: "tick", afterMs: 100, actions: [share] }],
      }),
      "root.onTap[0].actions[0]",
    );
  });

  test("onEndReached refuses a share", () => {
    refused(
      {
        ...spec({
          type: "list",
          repeat: { items: { path: "/rows" }, as: "item", key: "id" },
          children: [{ type: "text", text: "{item.title}" }],
          onEndReached: [share],
        }),
        data: { rows: [{ id: "row", title: "Hi" }] },
      },
      "root.onEndReached[0]",
    );
  });

  for (const followUp of ["onSuccess", "onError"]) {
    test(`${followUp} inherits refusal from onAppear`, () => {
      refused(
        spec({ type: "text", text: "Hi", onAppear: [request(followUp)] }),
        `root.onAppear[0].${followUp}[0]`,
      );
    });
    test(`${followUp} inherits permission from onTap`, () => {
      expect(
        validatePrototypeSpec(spec({ type: "button", label: "Go", onTap: [request(followUp)] }))
          .success,
      ).toBe(true);
    });
  }

  for (const key of ["onTap", "onLongPress", "onDoubleTap"]) {
    test(`${key} allows a share`, () => {
      expect(
        validatePrototypeSpec(spec({ type: "text", text: "Share", [key]: [share] })).success,
      ).toBe(true);
    });
  }
  test("onSubmit allows a share", () => {
    expect(
      validatePrototypeSpec({
        ...spec({ type: "textField", stateKey: "query", onSubmit: [share] }),
        state: { query: "" },
      }).success,
    ).toBe(true);
  });

  test("the use scanner gives a node-root call no gesture", () => {
    // Structural validation rejects an action in a node slot first; pin the policy seam too.
    expect(prototypePlatformError(spec(share), [], () => undefined)).toEqual({
      path: "root",
      message,
    });
  });

  test("non-flagged clipboard.copy remains valid under onAppear", () => {
    expect(
      validatePrototypeSpec({
        ...spec({
          type: "text",
          text: "Hi",
          onAppear: [{ type: "platform", call: "clipboard.copy", args: { text: { value: "Hi" } } }],
        }),
        requires: { platform: ["clipboard"] },
      }).success,
    ).toBe(true);
  });
});

describe("platform event gesture provenance", () => {
  const post = {
    type: "platform",
    call: "notifications.post",
    args: { id: { value: "msg" }, channel: { value: "messages" }, title: { value: "Hi" } },
  };
  const input = (event: string) => ({
    ...spec({ type: "spacer" }),
    requires: {
      platform: ["notifications", "device", "map", "sensors"],
      permissions: [{ name: "notifications", purpose: "Messages" }],
    },
    notifications: { channels: [{ id: "messages", name: "Messages", importance: "default" }] },
    platform: { on: { [event]: [post] } },
  });
  for (const event of [
    "device.changed",
    "notifications.dismissed",
    "notifications.scheduledFired",
  ]) {
    test(`${event} refuses a notification`, () => {
      expect(validatePrototypeSpec(input(event))).toEqual({
        success: false,
        error: {
          path: `platform.on[${JSON.stringify(event)}][0]`,
          message:
            "Side-effecting platform call notifications.post needs a user gesture: move it into onTap, onLongPress, onDoubleTap or onSubmit",
        },
      });
    });
  }
  for (const event of [
    "notifications.opened",
    "notifications.action",
    "notifications.reply",
    "map.markerTap",
  ]) {
    test(`${event} allows a notification`, () => {
      expect(validatePrototypeSpec(input(event)).success).toBe(true);
    });
  }
  test("event bindings under platform.on are refused through a timer", () => {
    const value = input("notifications.opened");
    const action = {
      type: "platform",
      call: "biometric.authenticate",
      args: { title: { event: "/title" } },
    };
    value.requires.platform.push("biometric");
    expect(
      validatePrototypeSpec({
        ...value,
        platform: { on: { "notifications.opened": [action] } },
      }).success,
    ).toBe(true);
    const timer = {
      type: "startTimer",
      id: "tick",
      afterMs: 100,
      actions: [action],
    };
    const timed = { ...value, platform: { on: { "notifications.opened": [timer] } } };
    expect(prototypePlatformUses(timed)).toContainEqual({
      kind: "event",
      path: 'platform.on["notifications.opened"][0].actions[0].args.title.event',
      inHandler: true,
      inTimer: true,
    });
    expect(validatePrototypeSpec(timed)).toEqual({
      success: false,
      error: {
        path: 'platform.on["notifications.opened"][0].actions[0].args.title.event',
        message:
          "{event} is unavailable in startTimer actions: copy the needed event fields into data or state before starting the timer",
      },
    });
  });
});

describe("platform contract rate-limit loader", () => {
  test("optional budgets preserve modules without a limit", () => {
    const modules = { clipboard: PROTOTYPE_PLATFORM_MODULES.clipboard };
    expect(loadPrototypePlatformModules(modules)).toBe(modules);
  });
  for (const field of ["calls", "windowMs"]) {
    for (const invalid of [0, -1, 1.5, Infinity, NaN, 2 ** 63]) {
      test(`${field} refuses ${invalid}`, () => {
        expect(() =>
          loadPrototypePlatformModules({
            share: {
              ...PROTOTYPE_PLATFORM_MODULES.share,
              rateLimit: { calls: 5, windowMs: 10000, [field]: invalid },
            },
          }),
        ).toThrow(
          "platformModules.share.rateLimit must contain positive integer calls and windowMs",
        );
      });
    }
  }
  test("budgets accept the largest representable integer below the Swift Int limit", () => {
    // The preceding IEEE-754 number is 1024 below 2 ** 63; subtracting 1 rounds back up.
    const largest = 2 ** 63 - 1024;
    const modules = {
      share: {
        ...PROTOTYPE_PLATFORM_MODULES.share,
        rateLimit: { calls: largest, windowMs: largest },
      },
    };
    expect(loadPrototypePlatformModules(modules)).toBe(modules);
  });
  test("the contract pins exactly the side-effecting calls and user-initiated events", () => {
    const flagged = Object.entries(PROTOTYPE_PLATFORM_MODULES).flatMap(([name, module]) =>
      Object.entries(module.calls)
        .filter(([, call]) => call.userGesture)
        .map(([call]) => `${name}.${call}`),
    );
    const initiated = Object.entries(PROTOTYPE_PLATFORM_MODULES).flatMap(([name, module]) =>
      Object.entries(module.events)
        .filter(([, event]) => event.userInitiated)
        .map(([event]) => `${name}.${event}`),
    );
    expect(flagged.sort()).toEqual([
      "notifications.post",
      "notifications.schedule",
      "notifications.setBadge",
      "share.open",
    ]);
    expect(initiated.sort()).toEqual([
      "map.markerTap",
      "notifications.action",
      "notifications.opened",
      "notifications.reply",
    ]);
    expect(
      Object.entries(PROTOTYPE_PLATFORM_MODULES)
        .filter(([, module]) => module.rateLimit)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["notifications", "share"]);
    expect(PROTOTYPE_PLATFORM_MODULES.share.rateLimit).toEqual({ calls: 5, windowMs: 10000 });
    expect(PROTOTYPE_PLATFORM_MODULES.notifications.rateLimit).toEqual({
      calls: 10,
      windowMs: 60000,
    });
  });
});
