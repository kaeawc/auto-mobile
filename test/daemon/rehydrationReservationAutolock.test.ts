import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// #11461 (restart ownership). "At the start of recovery the device of every persisted session is
// reserved, so no other caller takes it while rows are recovered one by one"
// (docs/using/device-ownership.md, #11294). Generic allocation skips a reserved device and an
// explicit bind is refused; the autolock acquisition path used to ignore the reservation. The
// HTTP MCP endpoint is already serving while startup rehydration runs, and the control socket is
// up while a late row is still recovering, so a sessionless tool call from any other client
// autolocked the reserved device; the row's own recovery then found it busy and the recoverable
// session was ended as `identity-recovery-target-busy`.

const SIM = "SIM-RESERVED-ROW";
const ROW = "5e550000-0000-4000-8000-00000000000c";
const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });

describe("restart-recovery reservation vs. an autolock acquisition by another client", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let sessions: SessionManager;
  let pool: DevicePool;

  const autolockAsOtherClient = () =>
    pool.autolockDevice(
      SIM,
      "ios",
      "another-mcp-client",
      undefined,
      undefined,
      ios(SIM),
      undefined,
      undefined,
      undefined,
      undefined,
      { autolockEnabled: true },
    );

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    await persistence.upsertActiveSession({
      sessionUuid: ROW,
      deviceId: SIM,
      stableDeviceId: SIM,
      platform: "ios",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 600_000,
      sessionTimeoutMs: 600_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: true,
    });
    await persistence.markReleased(ROW, "expired", 0, "daemon-restart");
    sessions = new SessionManager(timer, persistence);
    sessions.stopCleanupTimer();
    const manager = new FakeDeviceManager();
    manager.bootedDevices = [ios(SIM)];
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "reservation-autolock", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([ios(SIM)]);
    // Startup rehydration's first step: every persisted row's device is held for that row.
    await pool.reserveDevicesForRehydration([
      { sessionId: ROW, target: { platform: "ios", stableDeviceId: SIM, deviceId: SIM } },
    ]);
    expect(pool.genericAvailability(SIM)).toBe("reserved");
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("another client's autolock does not take the reserved device", async () => {
    const outcome = await autolockAsOtherClient().then(
      (sessionId) => `autolocked as ${sessionId === undefined ? "nothing" : "a new session"}`,
      () => "refused",
    );

    expect({ outcome, holder: pool.getDevice(SIM)?.sessionId ?? null }).toEqual({
      outcome: "refused",
      holder: null,
    });
  });

  test("the reserved row still recovers onto its device after that autolock attempt", async () => {
    await autolockAsOtherClient().catch(() => undefined);

    const recovery = await sessions.getOrCreateSession(ROW, pool, "ios", undefined, true).then(
      (session) => `recovered on ${session.assignedDevice}`,
      () => "lost",
    );

    expect({
      recovery,
      terminal: sessions.getTerminalReleaseSnapshot(ROW)?.releaseReason,
    }).toEqual({ recovery: `recovered on ${SIM}`, terminal: undefined });
  });
});
