import { describe, expect, test } from "bun:test";
import { PortReverseError } from "../../../src/features/portReverse/PortReverseError";
import {
  PortReverseManager,
  type PortReverseTarget,
} from "../../../src/features/portReverse/PortReverseManager";
import { FakeAdbReverseCommands } from "../../fakes/FakeAdbReverseCommands";

const setup = () => {
  const adb = new FakeAdbReverseCommands();
  const manager = new PortReverseManager(() => undefined);
  const target: PortReverseTarget = { deviceId: "emulator-5554", owner: "s1", adb };
  return { adb, manager, target };
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

describe("PortReverseManager deviceListener", () => {
  test("list and verify report reverse, none and a process with its package", async () => {
    const { adb, manager, target } = setup();
    await manager.ensure(target, [{ devicePort: 8080, hostPort: 8080 }]);
    adb.processListeners.set(9000, 10123);
    adb.packages.set(10123, "com.example.app");
    const listed = await manager.list(target);
    expect(listed.mappings.map((m) => [m.devicePort, m.deviceListener])).toEqual([
      [8080, { kind: "reverse" }],
    ]);
    const verified = await manager.verify(target, [8080, 9000, 9100]);
    expect(verified.mappings.map((m) => [m.devicePort, m.status, m.deviceListener])).toEqual([
      [8080, "present", { kind: "reverse" }],
      [9000, "missing", { kind: "process", uid: 10123, package: "com.example.app" }],
      [9100, "missing", { kind: "none" }],
    ]);
    // One table read per call; one package lookup for the one process.
    expect(adb.diagnosticCalls).toEqual(["listeners", "listeners", "package 10123"]);
  });

  test("a uid with no single package is reported without one", async () => {
    const { adb, manager, target } = setup();
    adb.processListeners.set(9000, 1000);
    const [mapping] = (await manager.verify(target, [9000])).mappings;
    expect(mapping?.deviceListener).toEqual({ kind: "process", uid: 1000 });
  });

  test("an unreadable table is unsupported, never a guess", async () => {
    const { adb, manager, target } = setup();
    adb.listenerTable = { kind: "unsupported", detail: "cat: /proc/net/tcp: Permission denied" };
    const [mapping] = (await manager.verify(target, [9000])).mappings;
    expect(mapping?.deviceListener).toEqual({
      kind: "unsupported",
      detail: "cat: /proc/net/tcp: Permission denied",
    });
    adb.listenerTable = undefined;
    adb.listenersError = new Error("adb: shell failed");
    const [failed] = (await manager.verify(target, [9000])).mappings;
    expect(failed?.deviceListener).toEqual({ kind: "unsupported", detail: "adb: shell failed" });
  });

  test("an add refused because a device process holds the port is device_port_in_use", async () => {
    const { adb, manager, target } = setup();
    adb.processListeners.set(9000, 10123);
    adb.packages.set(10123, "com.example.app");
    const error = await rejection(manager.ensure(target, [{ devicePort: 9000, hostPort: 9000 }]));
    expect(error).toBeInstanceOf(PortReverseError);
    expect((error as PortReverseError).toPayload()).toEqual({
      errorCode: "port_reverse_device_port_in_use",
      ports: [9000],
    });
    expect((error as PortReverseError).message).toContain("com.example.app (uid 10123)");
    expect(manager.ownedPorts("emulator-5554")).toEqual([]);
  });

  test("an add that fails with no device listener keeps the generic adb error", async () => {
    const { adb, manager, target } = setup();
    adb.failAdd.add(9000);
    const error = await rejection(manager.ensure(target, [{ devicePort: 9000, hostPort: 9000 }]));
    expect(error).not.toBeInstanceOf(PortReverseError);
    expect(String(error)).toContain("cannot bind");
  });
});
