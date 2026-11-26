import { describe, expect, test } from "bun:test";
import { registerIosHingeAngleBootCleanup } from "../../src/daemon/iosHingeAngleBootCleanup";
import { InMemoryIosRequestedHingeAngleStore } from "../../src/features/device/DuoHingeLayout";
import { DefaultSimulatorBootHooks } from "../../src/utils/ios-cmdline-tools/simulatorBootHooks";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("iPhone Duo requested hinge angle after a boot (#19406)", () => {
  test("a boot forgets the booted simulator's requested angle only", async () => {
    const hooks = new DefaultSimulatorBootHooks();
    const store = new InMemoryIosRequestedHingeAngleStore();
    store.record("DUO-A", 130);
    store.record("DUO-B", 90);
    registerIosHingeAngleBootCleanup(hooks, store);

    hooks.notifyBooted("DUO-A");
    await flush();
    await flush();

    expect(store.requested("DUO-A")).toBeUndefined();
    expect(store.requested("DUO-B")).toBe(90);
  });

  test("unregistering stops the cleanup", async () => {
    const hooks = new DefaultSimulatorBootHooks();
    const store = new InMemoryIosRequestedHingeAngleStore();
    store.record("DUO-A", 130);
    registerIosHingeAngleBootCleanup(hooks, store)();

    hooks.notifyBooted("DUO-A");
    await flush();
    await flush();

    expect(store.requested("DUO-A")).toBe(130);
  });
});
