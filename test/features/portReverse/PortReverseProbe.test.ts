import { describe, expect, test } from "bun:test";
import {
  PORT_PROBE_TIMEOUT_MS,
  PortReverseManager,
  type PortReverseTarget,
} from "../../../src/features/portReverse/PortReverseManager";
import { DeviceLostError } from "../../../src/models/DeviceLostError";
import { FakeAdbReverseCommands } from "../../fakes/FakeAdbReverseCommands";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const setup = () => {
  const adb = new FakeAdbReverseCommands();
  const timer = new FakeTimer();
  const manager = new PortReverseManager(() => undefined, timer);
  const target: PortReverseTarget = { deviceId: "emulator-5554", owner: "s1", adb };
  return { adb, timer, manager, target };
};

const probeCalls = (adb: FakeAdbReverseCommands) =>
  adb.calls.filter((call) => call.startsWith("probe"));

describe("PortReverseManager verify probe", () => {
  test("a mapping the host keeps open is reachable", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    adb.probeOutcomes.set(8080, [{ kind: "held" }]);
    const result = await manager.verify(target, undefined, { probe: true });
    expect(result.mappings).toEqual([
      { devicePort: 8080, host: "tcp:8080", hostPort: 8080, owned: true, status: "reachable" },
    ]);
  });

  test("a refused connect is unreachable with reason refused", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    adb.probeOutcomes.set(8080, [{ kind: "refused" }]);
    const [mapping] = (await manager.verify(target, undefined, { probe: true })).mappings;
    expect(mapping).toMatchObject({ status: "unreachable", probeReason: "refused" });
  });

  test("a peer that closes at once is asked twice, then unreachable with reason closed", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    adb.probeOutcomes.set(8080, [{ kind: "closed" }]);
    const [mapping] = (await manager.verify(target, undefined, { probe: true })).mappings;
    expect(mapping).toMatchObject({ status: "unreachable", probeReason: "closed" });
    expect(probeCalls(adb)).toEqual(["probe 8080", "probe 8080"]);
  });

  test("a first-connect close that the retry sees open is reachable", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    adb.probeOutcomes.set(8080, [{ kind: "closed" }, { kind: "held" }]);
    const [mapping] = (await manager.verify(target, undefined, { probe: true })).mappings;
    expect(mapping?.status).toBe("reachable");
  });

  test("a probe that never answers is unreachable with reason timeout, bounded by the timer", async () => {
    const { adb, timer, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    adb.probeOutcomes.set(8080, ["hang"]);
    const pending = manager.verify(target, undefined, { probe: true });
    await drainMicrotasks(50);
    timer.advanceTime(PORT_PROBE_TIMEOUT_MS);
    const [mapping] = (await pending).mappings;
    expect(mapping).toMatchObject({ status: "unreachable", probeReason: "timeout" });
  });

  test("device loss during the probe propagates instead of reporting unreachable", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    const lost = new DeviceLostError("emulator-5554", "device offline");
    adb.probeError = lost;
    await expect(manager.verify(target, undefined, { probe: true })).rejects.toBe(lost);
  });

  test("a missing mapping is not probed", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();
    adb.failAdd.add(8080);
    const result = await manager.verify(target, [8080, 9999], { probe: true });
    expect(result.mappings.map((m) => [m.devicePort, m.status])).toEqual([
      [8080, "missing"],
      [9999, "missing"],
    ]);
    expect(probeCalls(adb)).toEqual([]);
  });

  test("an unsupported device shell reports probe_unsupported with the device output", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    adb.probeOutcomes.set(8080, [{ kind: "unsupported", detail: "nc: not found" }]);
    const [mapping] = (await manager.verify(target, undefined, { probe: true })).mappings;
    expect(mapping).toMatchObject({
      status: "probe_unsupported",
      probeReason: "unsupported",
      probeDetail: "nc: not found",
    });
  });

  test("without probe, verify reports present and never connects", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    const withFalse = await manager.verify(target, undefined, { probe: false });
    const without = await manager.verify(target);
    expect(withFalse.mappings[0]?.status).toBe("present");
    expect(without).toEqual(withFalse);
    expect(probeCalls(adb)).toEqual([]);
  });
});
