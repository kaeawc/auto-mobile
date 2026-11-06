import { describe, expect, test } from "bun:test";
import { PortReverseError } from "../../../src/features/portReverse/PortReverseError";
import {
  PortReverseManager,
  type PortReverseTarget,
} from "../../../src/features/portReverse/PortReverseManager";
import { DeviceLostError } from "../../../src/models/DeviceLostError";
import { FakeAdbReverseCommands } from "../../fakes/FakeAdbReverseCommands";
import { FakeHostLoopbackProbe } from "../../fakes/FakeHostLoopbackProbe";
import { FakeTimer } from "../../fakes/FakeTimer";

const setup = () => {
  const adb = new FakeAdbReverseCommands();
  const host = new FakeHostLoopbackProbe();
  const audit: string[] = [];
  const manager = new PortReverseManager((event) => audit.push(event), new FakeTimer(), host);
  const target = (owner = "s1", holdsDevice = true): PortReverseTarget => ({
    deviceId: "emulator-5554",
    owner,
    adb,
    holdsDevice,
  });
  return { adb, host, audit, manager, target };
};

const rejection = async (promise: Promise<unknown>): Promise<PortReverseError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof PortReverseError)) {
    throw new Error(`expected PortReverseError, got ${String(error)}`);
  }
  return error;
};

const removes = (adb: FakeAdbReverseCommands) =>
  adb.calls.filter((call) => call.startsWith("remove"));

const reclaim = { reclaimStale: true };

describe("PortReverseManager conflictKind", () => {
  test("another live session's mapping is other_session, even with reclaimStale", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target("s2"), [{ devicePort: 5000, hostPort: 5000 }]);
    const error = await rejection(
      manager.ensure(target("s1"), [{ devicePort: 5000, hostPort: 5000 }], reclaim),
    );
    expect(error.toPayload()).toEqual({
      errorCode: "port_reverse_conflict",
      ports: [5000],
      conflicts: [{ devicePort: 5000, conflictKind: "other_session" }],
      conflictKind: "other_session",
    });
    expect(removes(adb)).toEqual([]);
  });

  test("an external mapping whose host target accepts is external_live", async () => {
    const { adb, host, manager, target } = setup();
    adb.mappings.set(3000, "tcp:3000");
    host.states.set(3000, "listening");
    const error = await rejection(manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }]));
    expect(error.toPayload().conflictKind).toBe("external_live");
  });

  test("an external mapping whose host is dead or unknown is external_unknown without reclaimStale", async () => {
    const { adb, host, manager, target } = setup();
    adb.mappings.set(3000, "tcp:3000");
    adb.mappings.set(4000, "localabstract:dev");
    adb.mappings.set(5000, "tcp:5000");
    host.states.set(5000, "unknown");
    const error = await rejection(
      manager.ensure(target(), [
        { devicePort: 3000, hostPort: 3000 },
        { devicePort: 4000, hostPort: 4000 },
        { devicePort: 5000, hostPort: 5000 },
      ]),
    );
    expect(error.toPayload()).toMatchObject({
      conflictKind: "external_unknown",
      ports: [3000, 4000, 5000],
    });
    expect(removes(adb)).toEqual([]);
  });

  test("mixed kinds are listed per port with no top-level conflictKind", async () => {
    const { adb, host, manager, target } = setup();
    await manager.ensure(target("s2"), [{ devicePort: 5000, hostPort: 5000 }]);
    adb.mappings.set(3000, "tcp:3000");
    host.states.set(3000, "listening");
    const payload = (
      await rejection(
        manager.ensure(target(), [
          { devicePort: 3000, hostPort: 3000 },
          { devicePort: 5000, hostPort: 5000 },
        ]),
      )
    ).toPayload();
    expect(payload.conflicts).toEqual([
      { devicePort: 3000, conflictKind: "external_live" },
      { devicePort: 5000, conflictKind: "other_session" },
    ]);
    expect(payload.conflictKind).toBeUndefined();
  });

  test("the caller's own clash carries no conflictKind", async () => {
    const { manager, target } = setup();
    await manager.ensure(target(), [{ devicePort: 5000, hostPort: 5000 }]);
    const payload = (
      await rejection(manager.ensure(target(), [{ devicePort: 5000, hostPort: 6000 }]))
    ).toPayload();
    expect(payload.conflicts).toEqual([{ devicePort: 5000 }]);
    expect(payload.conflictKind).toBeUndefined();
  });
});

describe("PortReverseManager reclaimStale", () => {
  test("reclaims an unowned tcp: mapping whose host refuses, re-checking before the removal", async () => {
    const { adb, audit, manager, target } = setup();
    adb.mappings.set(3000, "tcp:4000");
    const result = await manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim);
    expect(result.mappings).toEqual([
      {
        devicePort: 3000,
        host: "tcp:3000",
        hostPort: 3000,
        owned: true,
        status: "added",
        reclaimed: { host: "tcp:4000", reason: "host_refused" },
      },
    ]);
    expect(adb.calls).toEqual(["list", "list", "remove 3000", "add 3000 3000 no-rebind"]);
    expect(audit[0]).toBe(
      "reclaim tcp:3000 -> tcp:4000 device=emulator-5554 session=s1 reason=host_refused",
    );
    expect(manager.ownedPorts("emulator-5554")).toEqual([3000]);
  });

  test("a caller that does not hold the device cannot reclaim", async () => {
    const { adb, manager, target } = setup();
    adb.mappings.set(3000, "tcp:3000");
    const error = await rejection(
      manager.ensure(target("sessionless", false), [{ devicePort: 3000, hostPort: 3000 }], reclaim),
    );
    expect(error.code).toBe("port_reverse_conflict");
    expect(error.message).toContain("needs a session that holds the device");
    expect(removes(adb)).toEqual([]);
  });

  test("a non-tcp host spec is not reclaimed", async () => {
    const { adb, host, manager, target } = setup();
    adb.mappings.set(3000, "localabstract:dev");
    const error = await rejection(
      manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim),
    );
    expect(error.message).toContain("localabstract:dev is not tcp:");
    expect(host.probed).toEqual([]);
    expect(removes(adb)).toEqual([]);
  });

  test("a host target that accepts, or cannot be checked, is not reclaimed", async () => {
    const { adb, host, manager, target } = setup();
    adb.mappings.set(3000, "tcp:3000");
    host.states.set(3000, "listening");
    const live = await rejection(
      manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim),
    );
    expect(live.toPayload().conflictKind).toBe("external_live");
    host.states.set(3000, "unknown");
    const unknown = await rejection(
      manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim),
    );
    expect(unknown.message).toContain("could not be checked");
    expect(removes(adb)).toEqual([]);
  });

  test("this session's own mapping re-pointed outside AutoMobile is not reclaimed", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }]);
    adb.mappings.set(3000, "tcp:9999");
    const error = await rejection(
      manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim),
    );
    expect(error.code).toBe("port_reverse_conflict");
    expect(adb.mappings.get(3000)).toBe("tcp:9999");
  });

  test("a mapping re-pointed between the check and the removal is left in place", async () => {
    const { adb, host, manager, target } = setup();
    adb.mappings.set(3000, "tcp:4000");
    host.onProbe = () => adb.mappings.set(3000, "tcp:5000");
    const error = await rejection(
      manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim),
    );
    expect(error.code).toBe("port_reverse_reclaim_failed");
    expect(adb.mappings.get(3000)).toBe("tcp:5000");
    expect(removes(adb)).toEqual([]);
  });

  test("a mapping that vanished before the removal is simply added, with nothing reclaimed", async () => {
    const { adb, host, manager, target } = setup();
    adb.mappings.set(3000, "tcp:4000");
    host.onProbe = () => adb.mappings.delete(3000);
    const result = await manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim);
    expect(result.mappings[0]).toMatchObject({ status: "added" });
    expect(result.mappings[0]?.reclaimed).toBeUndefined();
    expect(removes(adb)).toEqual([]);
  });

  test("a failed removal is port_reverse_reclaim_failed and rolls back earlier adds", async () => {
    const { adb, manager, target } = setup();
    adb.mappings.set(3000, "tcp:4000");
    adb.failRemove.add(3000);
    const error = await rejection(
      manager.ensure(
        target(),
        [
          { devicePort: 2000, hostPort: 2000 },
          { devicePort: 3000, hostPort: 3000 },
        ],
        reclaim,
      ),
    );
    expect(error.code).toBe("port_reverse_reclaim_failed");
    expect([...adb.mappings]).toEqual([[3000, "tcp:4000"]]);
    expect(manager.ownedPorts("emulator-5554")).toEqual([]);
  });
});

describe("PortReverseManager list hostListening", () => {
  test("reports hostListening per tcp: mapping and omits it when unknown or not tcp:", async () => {
    const { adb, host, manager, target } = setup();
    adb.mappings.set(3000, "tcp:3000");
    adb.mappings.set(4000, "tcp:4000");
    adb.mappings.set(5000, "tcp:5000");
    adb.mappings.set(6000, "localabstract:dev");
    host.states.set(3000, "listening");
    host.states.set(5000, "unknown");
    const { mappings } = await manager.list(target());
    expect(mappings.map((m) => [m.devicePort, m.hostListening])).toEqual([
      [3000, true],
      [4000, false],
      [5000, undefined],
      [6000, undefined],
    ]);
    expect("hostListening" in (mappings[2] ?? {})).toBe(false);
  });
});

describe("PortReverseManager reclaim device loss", () => {
  test("device loss during the re-list or the removal propagates as itself", async () => {
    const { adb, host, manager, target } = setup();
    const lost = new DeviceLostError("emulator-5554", "gone");
    adb.mappings.set(3000, "tcp:4000");
    host.onProbe = () => {
      adb.failList = true;
    };
    const originalList = adb.list.bind(adb);
    adb.list = async () => {
      if (adb.failList) {
        throw lost;
      }
      return originalList();
    };
    await expect(
      manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim),
    ).rejects.toBe(lost);
    adb.failList = false;
    host.onProbe = undefined;
    adb.remove = async () => {
      throw lost;
    };
    await expect(
      manager.ensure(target(), [{ devicePort: 3000, hostPort: 3000 }], reclaim),
    ).rejects.toBe(lost);
    expect(adb.mappings.get(3000)).toBe("tcp:4000");
  });
});
