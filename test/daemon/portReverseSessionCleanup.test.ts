import { describe, expect, test } from "bun:test";
import {
  registerPortReverseSessionCleanup,
  type PortReverseSessionHooks,
} from "../../src/daemon/portReverseSessionCleanup";
import { PortReverseManager } from "../../src/features/portReverse/PortReverseManager";
import { FakeAdbReverseCommands } from "../fakes/FakeAdbReverseCommands";

type ReleaseListener = Parameters<PortReverseSessionHooks["onSessionRelease"]>[0];
type UnboundListener = Parameters<PortReverseSessionHooks["onSessionDeviceUnbound"]>[0];

class FakeHooks implements PortReverseSessionHooks {
  readonly pending: { deviceId: string; cleanup: Promise<unknown>; name: string }[] = [];
  release: ReleaseListener = () => undefined;
  unbound: UnboundListener = () => undefined;

  onSessionRelease(listener: ReleaseListener): void {
    this.release = listener;
  }

  onSessionDeviceUnbound(listener: UnboundListener): void {
    this.unbound = listener;
  }

  registerPendingDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    bound: { name: string },
  ): void {
    this.pending.push({ deviceId, cleanup, name: bound.name });
  }
}

const setup = async () => {
  const adb = new FakeAdbReverseCommands();
  const manager = new PortReverseManager(() => undefined);
  await manager.ensure({ deviceId: "emulator-5554", owner: "s1", adb }, [
    { devicePort: 8080, hostPort: 8080 },
  ]);
  const hooks = new FakeHooks();
  registerPortReverseSessionCleanup(hooks, manager);
  return { adb, hooks };
};

describe("portReverse session cleanup", () => {
  test("release removes the session's mappings as pending device cleanup", async () => {
    const { adb, hooks } = await setup();
    hooks.release("s1", "emulator-5554", "released", {});
    const { pending } = hooks;
    expect(pending.map((p) => [p.deviceId, p.name])).toEqual([
      ["emulator-5554", "remove adb reverse mappings"],
    ]);
    await Promise.all(pending.map((p) => p.cleanup));
    expect(adb.mappings.size).toBe(0);
  });

  test("an upgrade-only release and a session without mappings register nothing", async () => {
    const { hooks } = await setup();
    hooks.release("s1", "emulator-5554", "released", { upgradeOnly: true });
    hooks.release("s2", "emulator-5554", "released", {});
    expect(hooks.pending).toEqual([]);
  });

  test("unbinding the device removes the session's mappings", async () => {
    const { adb, hooks } = await setup();
    hooks.unbound("s1", "emulator-5554");
    await Promise.all(hooks.pending.map((p) => p.cleanup));
    expect(adb.mappings.size).toBe(0);
  });

  test("a release while the session's first ensure awaits adb add still removes it", async () => {
    const adb = new FakeAdbReverseCommands();
    const manager = new PortReverseManager(() => undefined);
    const hooks = new FakeHooks();
    registerPortReverseSessionCleanup(hooks, manager);
    const gate = Promise.withResolvers<void>();
    adb.addGate = gate.promise;
    const ensured = manager.ensure({ deviceId: "emulator-5554", owner: "s1", adb }, [
      { devicePort: 8080, hostPort: 8080 },
    ]);
    // Let the ensure's --list run so it is parked on the deferred add.
    while (!adb.calls.includes("add 8080 8080 no-rebind")) {
      await Promise.resolve();
    }
    hooks.release("s1", "emulator-5554", "released", {});
    expect(hooks.pending.map((p) => p.name)).toEqual(["remove adb reverse mappings"]);
    gate.resolve();
    await ensured;
    await Promise.all(hooks.pending.map((p) => p.cleanup));
    expect(adb.mappings.size).toBe(0);
    expect(manager.ownedPorts("emulator-5554")).toEqual([]);
    expect(manager.hasOwnedMappings("s1", "emulator-5554")).toBe(false);
  });

  test("a release racing an ensure whose add fails registers cleanup that finds nothing", async () => {
    const adb = new FakeAdbReverseCommands();
    const manager = new PortReverseManager(() => undefined);
    const hooks = new FakeHooks();
    registerPortReverseSessionCleanup(hooks, manager);
    const gate = Promise.withResolvers<void>();
    adb.addGate = gate.promise;
    adb.failAdd.add(8080);
    const ensured = manager
      .ensure({ deviceId: "emulator-5554", owner: "s1", adb }, [
        { devicePort: 8080, hostPort: 8080 },
      ])
      .then(
        () => "ok",
        () => "failed",
      );
    hooks.release("s1", "emulator-5554", "released", {});
    gate.resolve();
    expect(await ensured).toBe("failed");
    await Promise.all(hooks.pending.map((p) => p.cleanup));
    expect(adb.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(manager.hasOwnedMappings("s1", "emulator-5554")).toBe(false);
  });

  test("identity replacement forgets the mappings without touching the new device", async () => {
    const { adb, hooks } = await setup();
    adb.calls.length = 0;
    hooks.release("s1", "emulator-5554", "released", { deviceIdentityReplaced: true });
    hooks.unbound("s1", "emulator-5554", { deviceIdentityReplaced: true });
    await Promise.resolve();
    expect(hooks.pending).toEqual([]);
    expect(adb.calls).toEqual([]);
    expect(adb.mappings.has(8080)).toBe(true);
  });
});
