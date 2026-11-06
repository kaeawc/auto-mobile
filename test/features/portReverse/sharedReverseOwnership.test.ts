import { describe, expect, test } from "bun:test";
import { AdbReverseOwnership } from "../../../src/features/portReverse/AdbReverseOwnership";
import { PortReverseError } from "../../../src/features/portReverse/PortReverseError";
import {
  PortReverseManager,
  type PortReverseTarget,
} from "../../../src/features/portReverse/PortReverseManager";
import {
  PrototypeAdbReverseManager,
  type PrototypeReverseAdb,
} from "../../../src/features/prototype/PrototypeAdbReverseManager";
import { FakeAdbReverseCommands } from "../../fakes/FakeAdbReverseCommands";

const DEVICE = "emulator-5554";

/** Both managers on one fake device, sharing one ownership view (#17253). */
const setup = () => {
  const adb = new FakeAdbReverseCommands();
  const ownership = new AdbReverseOwnership();
  const sessions = new PortReverseManager(() => {}, undefined, undefined, ownership);
  const prototypes = new PrototypeAdbReverseManager(ownership);
  const prototypeAdb: PrototypeReverseAdb = {
    listReverses: async () =>
      new Map((await adb.list()).map((entry) => [entry.devicePort, entry.hostPort])),
    addReverse: (port) => adb.add(port, port, { noRebind: true }),
    removeReverse: (port) => adb.remove(port),
  };
  const target = (owner = "s1"): PortReverseTarget => ({ deviceId: DEVICE, owner, adb });
  const show = (id: string, port: number) =>
    prototypes.sync(
      DEVICE,
      id,
      {
        root: {
          type: "box",
          onTap: [{ type: "request", via: "device", url: `http://localhost:${port}/health` }],
        },
      },
      prototypeAdb,
    );
  return { adb, sessions, prototypes, target, show };
};

const removals = (adb: FakeAdbReverseCommands) =>
  adb.calls.filter((call) => call.startsWith("remove"));

/** Lets queued work run until the fake records `call` (bounded, no timers). */
const until = async (adb: FakeAdbReverseCommands, call: string) => {
  for (let turn = 0; turn < 100 && !adb.calls.includes(call); turn++) {
    await Promise.resolve();
  }
  expect(adb.calls).toContain(call);
};

describe("shared adb reverse ownership", () => {
  test("session remove keeps a mapping a prototype relies on; the prototype's release removes it", async () => {
    const { adb, sessions, prototypes, target, show } = setup();
    await sessions.ensure(target(), [{ devicePort: 18705, hostPort: 18705 }]);
    await show("p", 18705);

    const removed = await sessions.remove(target(), [18705]);
    expect(removed.mappings).toEqual([
      {
        devicePort: 18705,
        host: "tcp:18705",
        hostPort: 18705,
        owned: false,
        owner: "prototype",
        status: "released",
      },
    ]);
    expect(adb.mappings.get(18705)).toBe("tcp:18705");
    expect(removals(adb)).toEqual([]);
    expect(sessions.ownedPorts(DEVICE)).toEqual([]);

    await prototypes.release(DEVICE, "p");
    expect(adb.mappings.has(18705)).toBe(false);
    expect(removals(adb)).toEqual(["remove 18705"]);
  });

  test("a session joins a prototype's mapping to the same host port; the last holder removes it", async () => {
    const { adb, sessions, prototypes, target, show } = setup();
    await show("p", 18704);

    const listed = await sessions.list(target());
    expect(
      listed.mappings.map(({ devicePort, owned, owner }) => ({ devicePort, owned, owner })),
    ).toEqual([{ devicePort: 18704, owned: false, owner: "prototype" }]);

    const ensured = await sessions.ensure(target(), [{ devicePort: 18704, hostPort: 18704 }]);
    expect(ensured.mappings[0]).toMatchObject({
      devicePort: 18704,
      owned: true,
      status: "present",
    });
    expect(sessions.ownedPorts(DEVICE)).toEqual([18704]);

    await prototypes.release(DEVICE, "p");
    expect(adb.mappings.get(18704)).toBe("tcp:18704");
    expect(removals(adb)).toEqual([]);

    const removed = await sessions.remove(target(), [18704]);
    expect(removed.mappings[0]?.status).toBe("removed");
    expect(adb.mappings.has(18704)).toBe(false);
  });

  test("a prototype's mapping to another host port is a prototype conflict, not external", async () => {
    const { adb, sessions, target, show } = setup();
    await show("p", 18704);

    const error = await sessions.ensure(target(), [{ devicePort: 18704, hostPort: 9000 }]).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (!(error instanceof PortReverseError)) {
      throw new Error(`expected PortReverseError, got ${String(error)}`);
    }
    expect(error.toPayload()).toMatchObject({
      errorCode: "port_reverse_conflict",
      conflictKind: "prototype",
    });
    expect(error.message).toContain("prototype");
    expect(error.message).not.toContain("not created by AutoMobile");
    expect(adb.mappings.get(18704)).toBe("tcp:18704");
  });

  test("session release leaves a shared port to the prototype and removes the rest", async () => {
    const { adb, sessions, target, show } = setup();
    await sessions.ensure(target(), [
      { devicePort: 18705, hostPort: 18705 },
      { devicePort: 18706, hostPort: 18706 },
    ]);
    await show("p", 18705);

    await sessions.releaseOwnerOnDevice("s1", DEVICE);
    expect([...adb.mappings.keys()]).toEqual([18705]);
    expect(removals(adb)).toEqual(["remove 18706"]);
  });

  test("a prototype's releaseAll keeps a port a session still owns", async () => {
    const { adb, sessions, prototypes, target, show } = setup();
    await show("p", 18704);
    await sessions.ensure(target(), [{ devicePort: 18704, hostPort: 18704 }]);

    await prototypes.releaseAll(DEVICE);
    expect(adb.mappings.get(18704)).toBe("tcp:18704");
    expect(removals(adb)).toEqual([]);
  });

  test("a prototype shown during a session's removal re-adds the port instead of joining it", async () => {
    const { adb, sessions, prototypes, target, show } = setup();
    await sessions.ensure(target(), [{ devicePort: 18705, hostPort: 18705 }]);
    let open = () => {};
    adb.removeGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const removing = sessions.remove(target(), [18705]);
    await until(adb, "remove 18705");
    const showing = show("p", 18705);
    await until(adb, "list");
    open();
    const [removed, report] = await Promise.all([removing, showing]);

    expect(removed.mappings[0]?.status).toBe("removed");
    expect(report.reverseFailures).toEqual([]);
    expect(adb.mappings.get(18705)).toBe("tcp:18705");
    expect(prototypes.ownedPorts(DEVICE)).toEqual([18705]);
  });

  test("a failed ensure gives back the prototype port it shared", async () => {
    const { adb, sessions, prototypes, target, show } = setup();
    await show("p", 18705);
    adb.failAdd.add(18706);

    await expect(
      sessions.ensure(target(), [
        { devicePort: 18705, hostPort: 18705 },
        { devicePort: 18706, hostPort: 18706 },
      ]),
    ).rejects.toThrow();
    expect(sessions.ownedPorts(DEVICE)).toEqual([]);
    expect(adb.mappings.get(18705)).toBe("tcp:18705");

    await prototypes.release(DEVICE, "p");
    expect(adb.mappings.has(18705)).toBe(false);
  });

  test("a prototype does not join a session port re-pointed outside AutoMobile", async () => {
    const { adb, sessions, prototypes, target, show } = setup();
    await sessions.ensure(target(), [{ devicePort: 18705, hostPort: 18705 }]);
    adb.mappings.set(18705, "tcp:9000");
    await show("p", 18705);
    expect(prototypes.ownedPorts(DEVICE)).toEqual([]);

    expect((await sessions.remove(target(), [18705])).mappings[0]?.status).toBe("foreign");
    await prototypes.release(DEVICE, "p");
    expect(adb.mappings.get(18705)).toBe("tcp:9000");
    expect(removals(adb)).toEqual([]);
  });

  test("a prototype adds a session port the device lost rather than joining it", async () => {
    const { adb, prototypes, target, sessions, show } = setup();
    await sessions.ensure(target(), [{ devicePort: 18705, hostPort: 18705 }]);
    adb.mappings.delete(18705);

    const report = await show("p", 18705);
    expect(report.reverseFailures).toEqual([]);
    expect(adb.mappings.get(18705)).toBe("tcp:18705");
    expect(prototypes.ownedPorts(DEVICE)).toEqual([18705]);
  });

  test("ensure does not share a prototype port re-pointed outside AutoMobile", async () => {
    const { adb, sessions, target, show } = setup();
    await show("p", 18705);
    adb.mappings.set(18705, "tcp:9000");

    await expect(
      sessions.ensure(target(), [{ devicePort: 18705, hostPort: 9000 }]),
    ).rejects.toThrow("not created by AutoMobile");
    expect(sessions.ownedPorts(DEVICE)).toEqual([]);
    expect(adb.mappings.get(18705)).toBe("tcp:9000");
  });
});
