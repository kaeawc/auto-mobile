import { expect, test } from "bun:test";
import { RegistryBindingExclusion } from "../../../../src/daemon/sessionBroker/provisioning/exclusion";
import { BindingRegistrySchemaUnsupportedError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import { SessionManager } from "../../../../src/daemon/sessionManager";
import { FakeDeviceManager } from "../../../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { makePool } from "../../../helpers/makePool";

test.each(["ios", "android"] as const)(
  "%s generic acquisition uses files only for an unsupported registry schema",
  async (platform) => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const device = { platform, deviceId: "device-1", name: "device-1" };
    manager.bootedDevices = [device];
    const error = new BindingRegistrySchemaUnsupportedError("/registry/slots.sqlite", [
      "2099_01_01_016_future_schema",
    ]);
    const exclusion = new RegistryBindingExclusion(async () => {
      throw error;
    }, timer);
    const pool = makePool(sessions, "registry-schema-acquire", {
      timer,
      deviceManager: manager,
      bindingExclusion: exclusion,
    });
    try {
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("generic-session", platform);
      expect(pool.getDevice(device.deviceId)?.sessionId).toBe("generic-session");
      expect(exclusion.degraded()?.mode).toBe("files_only");
    } finally {
      sessions.stopCleanupTimer();
      timer.reset();
    }
  },
);

test.each(["ios", "android"] as const)(
  "%s existing holder retains control when an unsupported registry appears",
  async (platform) => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new FakeDeviceManager();
    const device = { platform, deviceId: "device-1", name: "device-1" };
    manager.bootedDevices = [device];
    let registryExists = false;
    const error = new BindingRegistrySchemaUnsupportedError("/registry/slots.sqlite", [
      "2099_01_01_016_future_schema",
    ]);
    const pool = makePool(sessions, "registry-schema-holder", {
      timer,
      deviceManager: manager,
      bindingExclusion: new RegistryBindingExclusion(
        async () => {
          throw error;
        },
        timer,
        () => registryExists,
      ),
    });
    try {
      await pool.initializeWithDevices([device]);
      await sessions.createSession("holder-session", device.deviceId, platform);
      await pool.assignDeviceToSession("holder-session", platform);
      registryExists = true;

      for (const action of ["tapOn", "input/tap", "terminateApp"]) {
        const input = { action, deviceId: device.deviceId, platform };
        await pool.assertNotAssignedToBinding({
          ...input,
          requesterSessionUuid: "holder-session",
        });
        await pool.assertNotAssignedToBinding({ ...input, requesterSessionUuid: "other-session" });
        await pool.assertNotAssignedToBinding(input);
      }
      expect(pool.getDevice(device.deviceId)?.sessionId).toBe("holder-session");
    } finally {
      sessions.stopCleanupTimer();
      timer.reset();
    }
  },
);
