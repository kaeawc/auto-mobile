import { describe, expect, test } from "bun:test";
import {
  createXrHeadsetInputHandler,
  traitsHeadsetCheck,
  xrHeadsetInputResultSchema,
  xrHeadsetInputSchema,
} from "../../src/server/xrHeadsetInputTool";
import {
  GrpcXrHeadsetInputInjector,
  type XrHeadsetInputRequest,
} from "../../src/features/xr/XrHeadsetInput";
import { DEVICE_TRAITS_TIMEOUT_MS } from "../../src/server/bootedDeviceTraits";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeDeviceTraits, androidDeviceTraits } from "../fakes/FakeDeviceTraits";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { toolJson } from "../helpers/toolResponse";

const headset: BootedDevice = { name: "XR", deviceId: "emulator-5554", platform: "android" };

function setup(isHeadset: boolean | undefined) {
  const sent: number[] = [];
  const requests: XrHeadsetInputRequest[] = [];
  const handler = createXrHeadsetInputHandler(
    async () => {
      const injector = new GrpcXrHeadsetInputInjector({
        send: async (events) => {
          sent.push(events.length);
        },
      });
      return {
        inject: (request) => {
          requests.push(request);
          return injector.inject(request);
        },
      };
    },
    async () => isHeadset,
  );
  return { handler, sent, requests };
}

describe("xrHeadsetInput tool", () => {
  test("drives a confirmed headset and returns the structured result", async () => {
    const { handler, sent, requests } = setup(true);
    const signal = new AbortController().signal;
    const json = toolJson(
      await handler(
        headset,
        { pointer: "hand", action: "select", x: 1280, y: 1279 },
        undefined,
        signal,
      ),
    );
    expect(json).toMatchObject({ success: true, field: "xr_hand_event", action: "select" });
    expect(xrHeadsetInputResultSchema.safeParse(json).success).toBe(true);
    expect(sent).toEqual([3]);
    expect(requests[0].signal).toBe(signal);
  });

  for (const isHeadset of [false, undefined]) {
    test(`refuses when headset identity is ${isHeadset} and sends nothing`, async () => {
      const { handler, sent } = setup(isHeadset);
      const call = handler(headset, { pointer: "eye", action: "select", x: 1, y: 1 });
      await expect(call).rejects.toBeInstanceOf(ActionableError);
      await expect(call).rejects.toThrow(
        isHeadset === false ? /only works on an Android XR headset/ : /not confirmed/,
      );
      expect(sent).toEqual([]);
    });
  }

  test("refuses iOS before reading traits", async () => {
    let checked = false;
    const handler = createXrHeadsetInputHandler(
      async () => {
        throw new Error("unreachable");
      },
      async () => {
        checked = true;
        return true;
      },
    );
    await expect(
      handler({ ...headset, platform: "ios" }, { pointer: "hand", action: "point", x: 0, y: 0 }),
    ).rejects.toThrow(/Android-only/);
    expect(checked).toBe(false);
  });

  test("validates pointers, actions and bounded integer coordinates", () => {
    const ok = { pointer: "hand", action: "select", x: 0, y: 16_384 };
    expect(xrHeadsetInputSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, pointer: "controller" },
      { ...ok, action: "grab" },
      { ...ok, x: -1 },
      { ...ok, y: 16_385 },
      { ...ok, x: 1.5 },
      { ...ok, holdMs: 5_001 },
      { ...ok, durationMs: -1 },
    ]) {
      expect(xrHeadsetInputSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("traitsHeadsetCheck", () => {
  test("profile or runtime identity confirms a headset without reading traits", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits());
    const check = traitsHeadsetCheck(traits, new FakeAdbClientFactory());
    for (const metadata of [
      { deviceType: "xr_headset_device" },
      { runtimeId: "system-images;android-34;google-xr;arm64-v8a" },
      { formFactor: "xr-headset" as const },
    ]) {
      expect(await check({ ...headset, ...metadata })).toBe(true);
    }
    expect(traits.reads).toEqual([]);
  });

  test("falls back to build traits with the shared timeout", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: "xr-headset" }));
    const check = traitsHeadsetCheck(traits, new FakeAdbClientFactory());
    expect(await check(headset)).toBe(true);
    expect(traits.reads).toEqual([
      { deviceId: headset.deviceId, options: { timeoutMs: DEVICE_TRAITS_TIMEOUT_MS } },
    ]);
    traits.setTraits(androidDeviceTraits({ formFactor: "xr-glasses" }));
    expect(await check(headset)).toBe(false);
    traits.setTraits(androidDeviceTraits());
    expect(await check(headset)).toBe(false);
    traits.setTraits(new Error("getprop timed out"));
    expect(await check(headset)).toBeUndefined();
  });
});
