import { describe, expect, test } from "bun:test";
import {
  PortReverseManager,
  type PortReverseTarget,
} from "../../../src/features/portReverse/PortReverseManager";
import { DeviceLostError } from "../../../src/models/DeviceLostError";
import { FakeAdbReverseCommands } from "../../fakes/FakeAdbReverseCommands";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";

const setup = async () => {
  const adb = new FakeAdbReverseCommands();
  const timer = new FakeTimer();
  const manager = new PortReverseManager(() => undefined, timer);
  const target: PortReverseTarget = { deviceId: "emulator-5554", owner: "s1", adb };
  await manager.ensure(target, [{ devicePort: 3000, hostPort: 3000 }]);
  return { adb, timer, manager, target };
};

const http = { path: "/metadata", expectStatus: [200] };

const probeOne = async (
  manager: PortReverseManager,
  target: PortReverseTarget,
  spec: Parameters<PortReverseManager["verify"]>[2],
) => (await manager.verify(target, [3000], spec)).mappings[0];

describe("PortReverseManager verify HTTP probe", () => {
  test("an expected status is reachable and reports httpStatus", async () => {
    const { adb, manager, target } = await setup();
    adb.httpOutcomes.set(3000, [{ kind: "response", status: 200, body: "{}" }]);
    expect(await probeOne(manager, target, { probe: { http } })).toMatchObject({
      status: "reachable",
      httpStatus: 200,
    });
    expect(adb.httpRequests).toEqual([
      { devicePort: 3000, request: { path: "/metadata", timeoutSeconds: 2 } },
    ]);
  });

  test("another status is unreachable with reason http_status", async () => {
    const { adb, manager, target } = await setup();
    adb.httpOutcomes.set(3000, [{ kind: "response", status: 404, body: "not found" }]);
    expect(await probeOne(manager, target, { probe: { http } })).toMatchObject({
      status: "unreachable",
      probeReason: "http_status",
      httpStatus: 404,
    });
  });

  test("a body without expectBodyContains is unreachable with reason http_body", async () => {
    const { adb, manager, target } = await setup();
    adb.httpOutcomes.set(3000, [{ kind: "response", status: 200, body: '{"name":"other"}' }]);
    const spec = { ...http, expectBodyContains: "mock-backend", hostHeader: "api.local" };
    expect(await probeOne(manager, target, { probe: { http: spec } })).toMatchObject({
      status: "unreachable",
      probeReason: "http_body",
      httpStatus: 200,
    });
    expect(adb.httpRequests[0]?.request.hostHeader).toBe("api.local");
  });

  test("no HTTP response is unreachable with no_http_response, after one retry", async () => {
    const { adb, manager, target } = await setup();
    adb.httpOutcomes.set(3000, [
      { kind: "no_response", detail: "connection closed without a response" },
    ]);
    expect(await probeOne(manager, target, { probe: { http } })).toMatchObject({
      status: "unreachable",
      probeReason: "no_http_response",
      probeDetail: "connection closed without a response",
    });
    expect(adb.httpRequests).toHaveLength(2);
  });

  test("a hung probe is unreachable with reason timeout, bounded by the timer", async () => {
    const { adb, timer, manager, target } = await setup();
    adb.httpOutcomes.set(3000, ["hang"]);
    const pending = probeOne(manager, target, { probe: { http: { ...http, timeoutMs: 3000 } } });
    await drainUntil(() => timer.getPendingTimeouts().length > 0, {
      description: "the HTTP probe deadline",
    });
    timer.advanceTime(3000 + 1500);
    expect(await pending).toMatchObject({ status: "unreachable", probeReason: "timeout" });
    expect(adb.httpRequests[0]?.request.timeoutSeconds).toBe(3);
  });

  test("a device-side timeout and a refused connect keep their reasons", async () => {
    const { adb, manager, target } = await setup();
    adb.httpOutcomes.set(3000, [{ kind: "timeout" }]);
    expect(await probeOne(manager, target, { probe: { http } })).toMatchObject({
      status: "unreachable",
      probeReason: "timeout",
    });
    adb.httpOutcomes.set(3000, [{ kind: "refused" }]);
    expect(await probeOne(manager, target, { probe: { http } })).toMatchObject({
      status: "unreachable",
      probeReason: "refused",
    });
  });

  test("device loss propagates; probe:true stays a TCP probe", async () => {
    const { adb, manager, target } = await setup();
    adb.probeOutcomes.set(3000, [{ kind: "held" }]);
    expect(await probeOne(manager, target, { probe: true })).toMatchObject({
      status: "reachable",
    });
    expect(adb.httpRequests).toEqual([]);
    const lost = new DeviceLostError("emulator-5554", "gone");
    adb.httpProbe = async () => {
      throw lost;
    };
    await expect(manager.verify(target, [3000], { probe: { http } })).rejects.toBe(lost);
  });
});
