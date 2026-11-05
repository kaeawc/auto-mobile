import { describe, expect, test } from "bun:test";
import { PortReverseError } from "../../../src/features/portReverse/PortReverseError";
import {
  PortReverseManager,
  type PortReverseTarget,
} from "../../../src/features/portReverse/PortReverseManager";
import { FakeAdbReverseCommands } from "../../fakes/FakeAdbReverseCommands";

const setup = () => {
  const adb = new FakeAdbReverseCommands();
  const audit: string[] = [];
  const manager = new PortReverseManager((event) => audit.push(event));
  const target = (owner = "s1"): PortReverseTarget => ({ deviceId: "emulator-5554", owner, adb });
  return { adb, audit, manager, target };
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

describe("PortReverseManager", () => {
  test("ensure adds a missing mapping with --no-rebind and is idempotent", async () => {
    const { adb, audit, manager, target } = setup();
    const first = await manager.ensure(target(), [{ devicePort: 8080, hostPort: 9090 }]);
    expect(first.mappings).toEqual([
      { devicePort: 8080, host: "tcp:9090", hostPort: 9090, owned: true, status: "added" },
    ]);
    const second = await manager.ensure(target(), [{ devicePort: 8080, hostPort: 9090 }]);
    expect(second.mappings[0]?.status).toBe("present");
    expect(adb.calls.filter((call) => call.startsWith("add"))).toEqual(["add 8080 9090 no-rebind"]);
    expect(audit).toEqual(["ensure tcp:8080 -> tcp:9090 device=emulator-5554 session=s1"]);
  });

  test("a foreign mapping is a typed conflict and stays in place", async () => {
    const { adb, manager, target } = setup();
    adb.mappings.set(3000, "tcp:3000");
    const error = await rejection(
      manager.ensure(target(), [
        { devicePort: 3000, hostPort: 3000 },
        { devicePort: 4000, hostPort: 4000 },
      ]),
    );
    expect(error.code).toBe("port_reverse_conflict");
    expect(error.ports).toEqual([3000]);
    // All-or-nothing: the non-conflicting port was not added either.
    expect([...adb.mappings]).toEqual([[3000, "tcp:3000"]]);
    expect(manager.ownedPorts("emulator-5554")).toEqual([]);
  });

  test("another session's mapping and a different host target are conflicts", async () => {
    const { manager, target } = setup();
    await manager.ensure(target("s1"), [{ devicePort: 5000, hostPort: 5000 }]);
    expect(
      (await rejection(manager.ensure(target("s2"), [{ devicePort: 5000, hostPort: 5000 }]))).code,
    ).toBe("port_reverse_conflict");
    expect(
      (await rejection(manager.ensure(target("s1"), [{ devicePort: 5000, hostPort: 5001 }]))).code,
    ).toBe("port_reverse_conflict");
  });

  test("remove refuses ports the session does not own", async () => {
    const { adb, manager, target } = setup();
    adb.mappings.set(3000, "tcp:3000");
    await manager.ensure(target("s2"), [{ devicePort: 5000, hostPort: 5000 }]);
    const error = await rejection(manager.remove(target("s1"), [3000, 5000]));
    expect(error.code).toBe("port_reverse_not_owned");
    expect(error.ports).toEqual([3000, 5000]);
    expect(adb.mappings.size).toBe(2);
  });

  test("remove re-checks --list and leaves a re-pointed port alone", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target(), [
      { devicePort: 5000, hostPort: 5000 },
      { devicePort: 6000, hostPort: 6000 },
    ]);
    adb.calls.length = 0;
    // Our 6000 was lost and someone else mapped it elsewhere; the manager must not restore it
    // over theirs, and remove must not delete theirs.
    adb.mappings.set(6000, "tcp:7777");
    const result = await manager.remove(target(), [5000]);
    expect(adb.calls).toEqual(["list", "remove 5000"]);
    expect(result.mappings).toEqual([
      { devicePort: 5000, host: "tcp:5000", hostPort: 5000, owned: false, status: "removed" },
    ]);
    const listed = await manager.list(target());
    expect(listed.mappings).toEqual([
      { devicePort: 6000, host: "tcp:7777", hostPort: 7777, owned: false, status: "present" },
    ]);
    expect(adb.mappings.get(6000)).toBe("tcp:7777");
  });

  test("a lost owned mapping is restored after a simulated transport drop", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();
    const verified = await manager.verify(target());
    expect(verified.restored).toEqual([8080]);
    expect(verified.mappings[0]).toMatchObject({ devicePort: 8080, status: "restored" });
    expect(adb.mappings.get(8080)).toBe("tcp:8080");
    adb.dropAll();
    expect((await manager.reconcile("emulator-5554")).restored).toEqual([8080]);
  });

  test("a failed restore is reported and retried on the next call", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target(), [{ devicePort: 8080, hostPort: 8080 }]);
    adb.dropAll();
    adb.failAdd.add(8080);
    const verified = await manager.verify(target());
    expect(verified.restoreFailures).toEqual([
      { devicePort: 8080, error: "adb: error: cannot bind" },
    ]);
    expect(verified.mappings[0]).toMatchObject({ owned: true, status: "missing" });
    adb.failAdd.clear();
    expect((await manager.list(target())).restored).toEqual([8080]);
  });

  test("session release removes only that session's mappings", async () => {
    const { adb, manager, target } = setup();
    adb.mappings.set(3000, "tcp:3000");
    await manager.ensure(target("s1"), [{ devicePort: 5000, hostPort: 5000 }]);
    await manager.ensure(target("s2"), [{ devicePort: 6000, hostPort: 6000 }]);
    await manager.releaseOwner("s1");
    expect([...adb.mappings.keys()].sort()).toEqual([3000, 6000]);
    await manager.releaseDeviceMappings("emulator-5554");
    expect([...adb.mappings.keys()]).toEqual([3000]);
    expect(adb.calls).not.toContain("remove 3000");
  });

  test("release on an unreachable device drops ownership without throwing", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target(), [{ devicePort: 5000, hostPort: 5000 }]);
    adb.failList = true;
    await manager.releaseOwner("s1");
    expect(manager.ownedPorts("emulator-5554")).toEqual([]);
  });

  test("a failed add rolls back the ports this call added", async () => {
    const { adb, manager, target } = setup();
    adb.failAdd.add(6000);
    await expect(
      manager.ensure(target(), [
        { devicePort: 5000, hostPort: 5000 },
        { devicePort: 6000, hostPort: 6000 },
      ]),
    ).rejects.toThrow("cannot bind");
    expect(adb.mappings.size).toBe(0);
    expect(manager.ownedPorts("emulator-5554")).toEqual([]);
  });

  test("one device port requested for two host ports is a conflict", async () => {
    const { manager, target } = setup();
    const error = await rejection(
      manager.ensure(target(), [
        { devicePort: 5000, hostPort: 5000 },
        { devicePort: 5000, hostPort: 5001 },
      ]),
    );
    expect(error.code).toBe("port_reverse_conflict");
  });
});
