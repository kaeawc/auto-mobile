import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { IosCtrlProxyHealthClient } from "../../src/ctrlProxy/ios/IosCtrlProxyHealthClient";
import type { BootedDevice } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { PortManager } from "../../src/utils/PortManager";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeIosCtrlProxyBuilder } from "../helpers/iosCtrlProxyBuilderFake";

// #14509: a host-control start that finds the device's runner already running via
// remoteRunner.status() adopts it rather than launching one. It must keep the 30s
// default health budget, not the 60s first-launch floor that only a runner this
// start actually spawned is owed.

type RemoteRunner = NonNullable<
  Parameters<typeof IOSCtrlProxyManager.createForTestingWithOptions>[0]["remoteRunner"]
>;

const SIMULATOR: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  platform: "ios",
  name: "iPhone 16 Simulator",
};
const PHYSICAL: BootedDevice = { ...SIMULATOR, deviceId: "00008030-001E28C11E" };
const RESIDENT_PID = 4242;
const RESIDENT_PORT = 8770;

interface RemoteFake {
  runner: RemoteRunner;
  starts: number;
}

/** A host-control runner that already has an (unhealthy) runner for the device. */
function remoteWithResidentRunner(resident: boolean): RemoteFake {
  const fake: RemoteFake = {
    starts: 0,
    runner: {
      isEnabled: () => true,
      isRunningInDocker: () => true,
      isAvailable: async () => true,
      getHost: () => "remote-host",
      runIdeviceId: async () => ({ success: true, data: { stdout: "" } }),
      runIdeviceInstaller: async () => ({ success: true, data: { stdout: "" } }),
      runSimctl: async () => ({ success: true, data: { stdout: "" } }),
      startIproxy: async () => ({ success: true, data: { pid: 99 } }),
      stopIproxy: async () => ({ success: true }),
      getIproxyStatus: async () => ({ success: true, data: { running: true } }),
      start: async () => {
        fake.starts += 1;
        return { success: true, data: { pid: RESIDENT_PID + 1, message: "started" } };
      },
      stop: async () => ({ success: true }),
      status: async ({ pid }) => {
        const trackedPid = fake.starts > 0 ? RESIDENT_PID + 1 : RESIDENT_PID;
        const running = resident || fake.starts > 0;
        return pid === undefined || pid === trackedPid
          ? { success: true, data: { running, pid: trackedPid, port: RESIDENT_PORT } }
          : { success: true, data: { running: false } };
      },
    },
  };
  return fake;
}

function createManager(device: BootedDevice, remote: RemoteFake) {
  const timer = new FakeTimer();
  const executor = new FakeProcessExecutor();
  const health = { pollStartedAt: [] as number[] };
  const manager = IOSCtrlProxyManager.createForTestingWithOptions({
    device,
    timer,
    builder: fakeIosCtrlProxyBuilder({
      getXctestrunPath: async () => "/tmp/CtrlProxy.xctestrun",
      getExpectedAppHash: () => "",
    }),
    processExecutor: executor,
    remoteRunner: remote.runner,
    hostPortAvailabilityChecker: { isAvailable: async () => true },
    steps: (defaults) => ({
      waitForHealthEndpoint: (...args) => {
        health.pollStartedAt.push(timer.now());
        return defaults.waitForHealthEndpoint(...args);
      },
    }),
  });
  return { manager, timer, health };
}

describe("IOSCtrlProxyManager adopted host-control runner deadline (#14509)", () => {
  let prevHealthMaxAttempts: string | undefined;
  const restores: Array<() => void> = [];

  beforeEach(() => {
    prevHealthMaxAttempts = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    // Host-control health probes would otherwise fetch the remote host; the runner never answers.
    const probes = [
      spyOn(IosCtrlProxyHealthClient.prototype, "checkHealthEndpointOnPortForDevice"),
      spyOn(IosCtrlProxyHealthClient.prototype, "checkHealthEndpointOnPortForDeviceWithReason"),
    ] as const;
    probes[0].mockResolvedValue(false);
    probes[1].mockResolvedValue({ ok: false, reason: "refused" });
    restores.push(...probes.map((probe) => () => probe.mockRestore()));
    for (const level of ["info", "warn", "debug"] as const) {
      const spy = spyOn(logger, level).mockImplementation(() => {});
      restores.push(() => spy.mockRestore());
    }
  });

  afterEach(() => {
    for (const restore of restores.splice(0)) {
      restore();
    }
    if (prevHealthMaxAttempts === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = prevHealthMaxAttempts;
    }
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test.each([
    ["simulator", SIMULATOR],
    ["physical device", PHYSICAL],
  ])("an unhealthy adopted %s runner keeps the 30s default budget", async (_label, device) => {
    const remote = remoteWithResidentRunner(true);
    const { manager, timer, health } = createManager(device, remote);
    timer.enableAutoAdvance();

    await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout (30s)");

    expect(remote.starts).toBe(0);
    expect(manager.getXcTestProcessId()).toBe(RESIDENT_PID);
    expect(timer.now() - health.pollStartedAt[0]).toBe(30_000);
  });

  test.each([
    ["simulator", SIMULATOR],
    ["physical device", PHYSICAL],
  ])("a %s runner this start launches keeps the 60s first-launch window", async (_l, device) => {
    const remote = remoteWithResidentRunner(false);
    const { manager, timer, health } = createManager(device, remote);
    timer.enableAutoAdvance();

    await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout (60s)");

    expect(remote.starts).toBe(1);
    expect(timer.now() - health.pollStartedAt[0]).toBe(60_000);
  });
});
