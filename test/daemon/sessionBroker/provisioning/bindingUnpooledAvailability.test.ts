import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../../../src/daemon/devicePool";
import { RegistryBindingExclusion } from "../../../../src/daemon/sessionBroker/provisioning/exclusion";
import { SessionManager } from "../../../../src/daemon/sessionManager";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeDeviceManager } from "../../../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../../helpers/devicePoolDependencies";
import { assignBindingDevice } from "./bindingFixtures";

/**
 * An erase reset shuts the iOS simulator down, so the pool drops it, yet the broker still
 * publishes its binding as idle. `listDevices` must report it broker-held, not unowned (#15233).
 */
describe("availability of a broker-bound device the pool does not list", () => {
  const BOUND_UDID = "11111111-2222-3333-4444-555555555555";
  let timer: FakeTimer;
  let sessions: SessionManager;

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  async function arrange(): Promise<DevicePool> {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const registry = new FakeBindingRegistry(timer);
    await assignBindingDevice(registry, "ios", BOUND_UDID, "runner-a", "binding-exec");
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "unpooled-binding-availability", {
        timer,
        deviceManager: new FakeDeviceManager(),
        bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([]);
    await pool.bindingStableIds("ios");
    return pool;
  }

  test("is held by the session broker, not free", async () => {
    const pool = await arrange();

    expect(pool.genericAvailability(BOUND_UDID)).toBe("session_broker");
  });

  test("an unrelated unpooled id stays free", async () => {
    const pool = await arrange();

    expect(pool.genericAvailability("ffffffff-0000-0000-0000-000000000000")).toBe("free");
  });
});
