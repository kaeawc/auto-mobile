import { describe, expect, test } from "bun:test";
import fixture from "../../fixtures/prototype-spec/platform-simulation/test-tick.json";
import { AndroidPrototypeTransport } from "../../../src/features/prototype/androidPrototypeTransport";
import { prototypePlatformDeliveredEventOf } from "../../../src/features/prototype/prototypePlatformEvent";
import { performPrototypeSimulate } from "../../../src/server/prototypeSimulateAction";
import { prototypeSchema } from "../../../src/server/prototypeTools";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";

const input = { action: "simulate", id: "panel", event: fixture.event, data: fixture.data };
function harness(capable = true) {
  const proxy = new FakeCtrlProxy(new FakeTimer());
  proxy.setSupportedCommands(capable ? ["prototype_platform_simulation_v1"] : []);
  return { proxy, target: { android: new AndroidPrototypeTransport(proxy) } };
}
describe("platform event simulation", () => {
  test("shared fixture validates and forwards unchanged through the Android transport", async () => {
    const { proxy, target } = harness();
    const args = prototypeSchema.parse(input);
    expect(await performPrototypeSimulate(target, args)).toEqual({ success: true });
    expect(proxy.simulatePlatformRequests).toEqual([
      { id: "panel", event: fixture.event, data: fixture.data },
    ]);
    expect<unknown>(
      prototypePlatformDeliveredEventOf({
        kind: "emit",
        name: "prototype_platform_event",
        payload: fixture.expected,
      }),
    ).toEqual(fixture.expected);
  });
  test("missing capability refuses without a request and explains the update", async () => {
    const { proxy, target } = harness(false);
    expect(await performPrototypeSimulate(target, prototypeSchema.parse(input))).toMatchObject({
      success: false,
      error: expect.stringContaining("prototype_platform_simulation_v1"),
    });
    expect(proxy.simulatePlatformRequests).toEqual([]);
  });
  test("unknown module or event supplies a contract hint", () => {
    for (const event of ["missing.tick", "test.missing", "tick", "__proto__.tick"]) {
      const parsed = prototypeSchema.safeParse({ ...input, event });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.message).toContain("known");
      }
    }
  });
  test("requires JSON objects and bounds the delivered UTF-8 payload", () => {
    for (const data of [
      [],
      null,
      { n: NaN },
      { n: undefined },
      { n: 1n },
      { text: "😀".repeat(1024) },
    ]) {
      expect(prototypeSchema.safeParse({ ...input, data }).success).toBe(false);
    }
    const overhead = Buffer.byteLength(
      JSON.stringify({ event: input.event, data: { text: "" }, simulated: true }),
    );
    expect(
      prototypeSchema.safeParse({ ...input, data: { text: "x".repeat(4096 - overhead) } }).success,
    ).toBe(true);
    expect(
      prototypeSchema.safeParse({ ...input, data: { text: "x".repeat(4097 - overhead) } }).success,
    ).toBe(false);
  });
  test("uses the existing cast event data schemas", () => {
    for (const data of [
      {},
      { volume: -1 },
      { volume: 1.1 },
      { volume: "loud" },
      { volume: 0.5, extra: true },
    ]) {
      const parsed = prototypeSchema.safeParse({ ...input, event: "cast.remoteVolume", data });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.message).toContain("event definition");
      }
    }
    expect(
      prototypeSchema.safeParse({ ...input, event: "cast.remoteVolume", data: { volume: 0.5 } })
        .success,
    ).toBe(true);
  });
  test("transport is exclusive to notifications.push", () => {
    expect(prototypeSchema.safeParse({ ...input, transport: "auto" }).success).toBe(false);
  });
  test("arbitrary JSON object keys are preserved", async () => {
    const { proxy, target } = harness();
    const data = JSON.parse('{"__proto__":{"nested":true},"value":[null,1,"ok"]}');
    expect(
      await performPrototypeSimulate(target, prototypeSchema.parse({ ...input, data })),
    ).toEqual({ success: true });
    expect(Object.hasOwn(proxy.simulatePlatformRequests[0]!.data, "__proto__")).toBe(true);
    expect(proxy.simulatePlatformRequests[0]!.data).toEqual(data);
  });
  test("device unsupported result is preserved and missing runtimes have an update hint", async () => {
    const { proxy, target } = harness();
    proxy.setSimulatePlatformResult({
      success: false,
      error: "unsupported: module has no simulation",
    });
    expect(await performPrototypeSimulate(target, prototypeSchema.parse(input))).toEqual({
      success: false,
      error: "unsupported: module has no simulation",
    });
    expect(await performPrototypeSimulate({}, prototypeSchema.parse(input))).toMatchObject({
      success: false,
      error: expect.stringContaining("the connected prototype runtime"),
    });
  });
});
