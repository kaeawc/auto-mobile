import { describe, expect, test } from "bun:test";
import fixture from "../../fixtures/prototype-spec/platform-simulation/test-echo-outcomes.json";
import { AndroidPrototypeTransport } from "../../../src/features/prototype/androidPrototypeTransport";
import { PROTOTYPE_PLATFORM_ERROR_CODES } from "../../../src/features/prototype/prototypePlatform";
import { validatePrototypePlatformOutcome } from "../../../src/features/prototype/prototypePlatformOutcomes";
import { performPrototypeSimulate } from "../../../src/server/prototypeSimulateAction";
import { prototypeSchema } from "../../../src/server/prototypeTools";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";

const call = "test.echo";

describe("prototype platform outcomes", () => {
  test("accepts JSON values and every platform error code", () => {
    for (const result of [null, false, 0, "", [1, null], { nested: { ok: true } }]) {
      expect(validatePrototypePlatformOutcome(call, { result }).issue).toBeUndefined();
    }
    for (const code of PROTOTYPE_PLATFORM_ERROR_CODES) {
      expect(validatePrototypePlatformOutcome(call, { error: { code } }).issue).toBeUndefined();
      expect(
        validatePrototypePlatformOutcome(call, { error: { code, message: "x".repeat(200) } }).issue,
      ).toBeUndefined();
    }
  });

  test("refuses unknown calls, malformed envelopes and non-JSON values", () => {
    for (const name of [
      "echo",
      "test.tick",
      "missing.echo",
      "test.constructor",
      "__proto__.echo",
    ]) {
      expect(validatePrototypePlatformOutcome(name, { result: null }).issue?.[0]).toBe("call");
    }
    for (const outcome of [
      {},
      null,
      [],
      { result: null, error: { code: "unavailable" } },
      { result: false, extra: true },
      { result: undefined },
      { result: NaN },
      { result: { nested: undefined } },
      { result: 1n },
      { result: () => 1 },
      { error: {} },
      { error: { code: "missing" } },
      { error: { code: "unavailable", message: null } },
      { error: { code: "unavailable", message: "x".repeat(201) } },
      { error: { code: "unavailable", extra: true } },
    ]) {
      expect(validatePrototypePlatformOutcome(call, outcome).issue?.[0]).toBe("outcome");
    }
  });

  test("bounds the whole UTF-8 wire envelope", () => {
    const multibyte = "😀".repeat(1020);
    const overhead = Buffer.byteLength(JSON.stringify({ result: multibyte }));
    const result = multibyte + "x".repeat(4096 - overhead);
    expect(Buffer.byteLength(JSON.stringify({ result }))).toBe(4096);
    expect(validatePrototypePlatformOutcome(call, { result }).issue).toBeUndefined();
    expect(validatePrototypePlatformOutcome(call, { result: result + "x" }).issue?.[1]).toContain(
      "4096-byte",
    );
  });

  test("replays the fixture over the host transport", async () => {
    const proxy = new FakeCtrlProxy(new FakeTimer());
    proxy.setSupportedCommands(["prototype_platform_outcomes_v1"]);
    const target = { android: new AndroidPrototypeTransport(proxy) };
    const requests = proxy.queueCallOutcomeRequests;
    const id = "panel";
    for (const step of fixture) {
      if (step.queue !== undefined) {
        const args = prototypeSchema.parse({ action: "simulate", id, call, outcome: step.queue });
        expect(await performPrototypeSimulate(target, args)).toEqual({ success: true });
      } else {
        // The TS host only sends queue requests. Native fixture tests run the real dispatcher.
        const queued = requests.shift();
        if (queued) {
          expect<unknown>(queued).toEqual({ id, call: step.call, outcome: step.expected });
        } else {
          expect(step.expected).toEqual({ result: step.args.message });
        }
      }
    }
    expect(requests).toEqual([]);
  });

  test("preserves device refusals and gives an update hint when no runtime supports outcomes", async () => {
    const proxy = new FakeCtrlProxy(new FakeTimer());
    proxy.setSupportedCommands(["prototype_platform_outcomes_v1"]);
    const args = prototypeSchema.parse({
      action: "simulate",
      id: "p",
      call,
      outcome: { result: null },
    });
    for (const error of [
      "Unknown or inactive prototype id: p",
      "Declare test in requires.platform before simulation",
      "No module registered for test.echo",
      "unsupported: platform module does not support simulation",
      "Unknown platform call: test.echo",
      "At most 16 outcomes can be queued for test.echo",
    ]) {
      proxy.setQueueCallOutcomeResult({ success: false, error });
      expect(
        await performPrototypeSimulate({ android: new AndroidPrototypeTransport(proxy) }, args),
      ).toEqual({ success: false, error });
    }
    expect(await performPrototypeSimulate({}, args)).toMatchObject({
      success: false,
      error: expect.stringContaining("prototype_platform_outcomes_v1"),
    });
  });
});
