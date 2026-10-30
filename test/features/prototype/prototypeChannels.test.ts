import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import contract from "../../../schemas/prototype-spec-contract.json";
import websocket from "../../fixtures/prototype-spec/valid/realtime-channels.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import * as limits from "../../../src/features/prototype/prototypeChannelLimits";

test("channel budgets come from the contract", () => {
  for (const [name, value] of Object.entries(limits)) {
    expect(value).toBe(contract.limits[name as keyof typeof contract.limits]);
  }
  expect(limits).toMatchObject({
    MAX_PROTOTYPE_CHANNELS: 4,
    MAX_PROTOTYPE_CHANNEL_FRAME_BYTES: 65536,
    MAX_PROTOTYPE_CHANNEL_SEND_BYTES: 16384,
    MAX_PROTOTYPE_CHANNELS_OPEN: 8,
    PROTOTYPE_CHANNEL_FLUSH_MS: 50,
  });
});

test("callback event reads have handler scope, including the whole event", () => {
  for (const callback of ["onOpen", "onClose", "onError"]) {
    const spec = structuredClone(websocket);
    Object.assign(spec.channels.chat, {
      [callback]: [{ type: "setData", path: "/data/latest", value: { event: "" } }],
    });
    expect(validatePrototypeSpec(spec).success).toBe(true);
  }
  const spec = structuredClone(websocket);
  Object.assign(spec.root, {
    onTap: [{ type: "setData", path: "/data/latest", value: { event: "" } }],
  });
  expect(validatePrototypeSpec(spec)).toEqual({
    success: false,
    error: {
      path: "root.onTap[0].value.event",
      message: "{event} is only available inside a platform.on handler",
    },
  });
});

test("unused components and nested lists gate realtime writes; opaque literals do not", () => {
  const action = {
    type: "upsertData",
    path: "/data/rows",
    key: "/id",
    value: { value: { id: 1 } },
  };
  for (const write of [
    action,
    { type: "appendData", path: action.path, value: action.value, maxItems: 10 },
  ]) {
    const spec = {
      components: {
        data: {
          root: {
            type: "text",
            text: "write",
            onTap: [{ type: "startTimer", id: "tick", afterMs: 100, actions: [write] }],
          },
        },
      },
      root: { type: "spacer" },
    };
    expect(prototypeGateCapabilities(spec)).toContain("prototype_platform_realtime_v1");
  }
  expect(
    prototypeGateCapabilities({
      root: {
        type: "text",
        text: "opaque",
        onTap: [{ type: "emit", name: "test", payload: action }],
      },
    }),
  ).not.toContain("prototype_platform_realtime_v1");
});

test("channel selectors require own declarations and preserve an authored __proto__ id", () => {
  const spec = {
    ...structuredClone(websocket),
    channels: Object.fromEntries([["__proto__", websocket.channels.chat]]),
    root: {
      ...websocket.root,
      visibleWhen: { platform: "/realtime/__proto__/status", equals: "open" },
      onTap: websocket.root.onTap.map((action) => ({
        ...action,
        args: { ...action.args, channel: "__proto__" },
      })),
    },
  };
  const result = validatePrototypeSpec(spec);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(Object.hasOwn(result.data.channels ?? {}, "__proto__")).toBe(true);
  }
});

// Shared fixtures assert the same acceptance boundary and exact errors in all three validators.
const reviewFixtures = new URL("../../fixtures/prototype-spec/", import.meta.url);
for (const name of readdirSync(new URL("invalid/", reviewFixtures)).filter(
  (name) =>
    name.startsWith("realtime-review-") ||
    (name.startsWith("strict-library-") && name.includes("channel")),
)) {
  const fixture = JSON.parse(readFileSync(new URL(`invalid/${name}`, reviewFixtures), "utf8"));
  test(`review parity ${name}`, () => {
    expect(
      validatePrototypeSpec(fixture.spec, {
        ...fixture.options,
        requiredCapabilities: prototypeGateCapabilities,
      }),
    ).toEqual({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    });
  });
}
for (const name of [
  "realtime-review-boundaries",
  "realtime-review-legacy-bindings",
  "realtime-review-menu-bindings",
]) {
  const spec = JSON.parse(readFileSync(new URL(`valid/${name}.json`, reviewFixtures), "utf8"));
  test(`review accepts ${name}`, () => {
    const supportedCapabilities = prototypeGateCapabilities(spec);
    expect(
      validatePrototypeSpec(spec, {
        library: true,
        supportedCapabilities,
        requiredCapabilities: prototypeGateCapabilities,
      }).success,
    ).toBe(true);
    if (name.endsWith("legacy-bindings")) {
      expect(supportedCapabilities).not.toContain("prototype_platform_realtime_v1");
    }
  });
}
