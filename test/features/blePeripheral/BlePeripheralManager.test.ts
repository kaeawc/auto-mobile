import { describe, expect, test } from "bun:test";
import { blePeripheralSchema } from "../../../src/features/blePeripheral/blePeripheralSchema";
import { ActionableError } from "../../../src/models/ActionableError";
import { blePeripheralFixture, bleStartArgs } from "../../helpers/blePeripheralFixture";

describe("session-owned BLE peripherals", () => {
  test("start, notify, status and stop use the same sidecar and handle", async () => {
    const { manager, sidecars, transports } = blePeripheralFixture();
    const started = await manager.run("s1", bleStartArgs());
    expect(started).toMatchObject({
      handle: "fake-1",
      name: "Prototype",
      address: "F0:F1:F2:F3:F4:F5",
      presets: ["battery", "heartRate"],
      running: true,
      bumbleReady: true,
    });
    expect(transports.calls).toEqual([{ deviceId: "emulator-5554", override: undefined }]);
    const notify = blePeripheralSchema.parse({
      action: "notify",
      handle: started.handle,
      characteristic: "battery",
      level: 42,
    });
    await manager.run("s1", notify);
    expect(sidecars.created[0].notifications).toEqual([notify]);
    sidecars.created[0].snapshot.connected = ["central"];
    sidecars.created[0].snapshot.subscribed = ["2A19"];
    const status = await manager.run(
      "s1",
      blePeripheralSchema.parse({ action: "status", handle: started.handle }),
    );
    expect(status).toMatchObject({ connected: ["central"], subscribed: ["2A19"] });
    const stopped = await manager.run(
      "s1",
      blePeripheralSchema.parse({ action: "stop", handle: started.handle }),
    );
    expect(stopped.running).toBe(false);
    expect(sidecars.created[0].stops).toBe(1);
    await manager.run("s1", blePeripheralSchema.parse({ action: "stop", handle: started.handle }));
  });

  test("multiple handles stay isolated across owners", async () => {
    const { manager, sidecars } = blePeripheralFixture();
    const first = await manager.run("s1", bleStartArgs());
    await manager.run("s1", { ...bleStartArgs(), address: "F0:F1:F2:F3:F4:F6" });
    await manager.run("s2", { ...bleStartArgs(), address: "F0:F1:F2:F3:F4:F7" });
    await expect(manager.run("s2", { action: "stop", handle: first.handle })).rejects.toThrow(
      /Unknown BLE handle/,
    );
    await manager.releaseSession("s1");
    expect(sidecars.created.map((sidecar) => sidecar.stops)).toEqual([1, 1, 0]);
    await expect(manager.run("s1", bleStartArgs())).rejects.toThrow(/ended/);
    await manager.shutdown();
    expect(sidecars.created[2].stops).toBe(1);
    await expect(manager.run("s3", bleStartArgs())).rejects.toThrow(/shutting down/);
  });

  test.each(["release", "shutdown"])("%s fences a start still provisioning", async (action) => {
    const { manager, sidecars, environments } = blePeripheralFixture();
    const gate = Promise.withResolvers<void>();
    environments.gate = gate.promise;
    const started = manager.run("s1", bleStartArgs());
    const rejected = started.catch((error: unknown) => error);
    await (action === "release" ? manager.releaseSession("s1") : manager.shutdown());
    gate.resolve();
    expect(await rejected).toBeInstanceOf(ActionableError);
    expect(sidecars.created[0].starts).toBe(0);
    expect(sidecars.created[0].snapshot.running).toBe(false);
  });

  test("release during sidecar startup kills it and refuses the late result", async () => {
    const { manager, sidecars, environments } = blePeripheralFixture();
    const env = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    environments.gate = env.promise;
    const started = manager.run("s1", bleStartArgs());
    const rejected = started.catch((error: unknown) => error);
    sidecars.created[0].startGate = gate.promise;
    env.resolve();
    while (!sidecars.created[0].starts) {
      await Promise.resolve();
    }
    await manager.releaseSession("s1");
    gate.resolve();
    expect(await rejected).toMatchObject({ message: "BLE owner released" });
    expect(sidecars.created[0].snapshot.running).toBe(false);
  });

  test("failed cleanup retains ownership for retry and still kills other sidecars", async () => {
    const { manager, sidecars } = blePeripheralFixture();
    await manager.run("s1", bleStartArgs());
    await manager.run("s1", { ...bleStartArgs(), address: "F0:F1:F2:F3:F4:F6" });
    sidecars.created[0].stopError = new Error("unconfirmed exit");
    await expect(manager.shutdown()).rejects.toThrow(/unconfirmed exit/);
    expect(sidecars.created[1].stops).toBe(1);
    sidecars.created[0].stopError = undefined;
    await manager.shutdown();
    expect(sidecars.created[0].stops).toBe(2);
  });

  test("cancellation while reading initial status kills the peripheral instead of returning a handle", async () => {
    const f = blePeripheralFixture();
    const provisioning = Promise.withResolvers<void>();
    const status = Promise.withResolvers<void>();
    const controller = new AbortController();
    f.environments.gate = provisioning.promise;
    const started = f.manager.run("s1", bleStartArgs(), controller.signal);
    const result = started.catch((error: unknown) => error);
    f.sidecars.created[0].statusGate = status.promise;
    provisioning.resolve();
    while (!f.sidecars.created[0].statusCalls) {
      await Promise.resolve();
    }
    controller.abort(new ActionableError("call canceled"));
    status.resolve();
    expect(await result).toMatchObject({ message: "call canceled" });
    expect(f.sidecars.created[0].stops).toBe(1);
    expect(f.sidecars.created[0].snapshot.running).toBe(false);
  });

  test("provisioning failure leaves no live handle", async () => {
    const { manager, environments, sidecars } = blePeripheralFixture();
    environments.error = new Error("pip offline");
    await expect(manager.run("s1", bleStartArgs())).rejects.toThrow(/pip offline/);
    expect(sidecars.created[0].stops).toBe(1);
    await expect(manager.run("s1", { action: "status", handle: "fake-1" })).rejects.toThrow(
      /Unknown BLE handle/,
    );
  });
});
