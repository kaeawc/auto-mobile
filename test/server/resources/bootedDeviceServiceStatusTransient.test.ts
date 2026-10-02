import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createInstantFailureWebSocketFactory } from "../../fakes/FakeWebSocket";
import {
  enrichDeviceServiceStatuses,
  probeServiceStatusWithBudget,
  queryDeviceServiceStatus,
  setServiceStatusProbe,
  type ServiceStatusProbe,
} from "../../../src/server/bootedDeviceResources";
import type { DeviceServiceStatus } from "../../../src/server/bootedDeviceResources";
import { describeDevice } from "../../../src/server/deviceDescription";
import { IOSCtrlProxyManager } from "../../../src/ctrlProxy/IOSCtrlProxyManager";
import { logger } from "../../../src/utils/logger";
import {
  IOSCtrlProxyClient,
  IOS_RUNNER_FEATURE_COMMANDS,
  IOS_RUNNER_FEATURE_FLAGS,
} from "../../../src/features/observe/ios/IOSCtrlProxyClient";
import {
  IOS_RUNNER_COMMAND_APPLICABILITY,
  getMissingIosRunnerFeatureCommands,
} from "../../../src/features/observe/ios/iosRunnerFeatureCommands";

describe("iOS service status command applicability", () => {
  for (const isVirtual of [true, false, undefined]) {
    for (const missing of ["set_hinge_angle", "set_voiceover_state", "request_shake"] as const) {
      test(`missing ${missing} with isVirtual=${isVirtual}`, async () => {
        const timer = new FakeTimer();
        const device = {
          name: "iPhone",
          platform: "ios" as const,
          deviceId: "00000000-0000-0000-0000-000000008547",
          source: "local" as const,
          isVirtual,
        };
        const manager = IOSCtrlProxyManager.getInstance(device, timer);
        const client = IOSCtrlProxyClient.createForTesting(
          device,
          18547,
          createInstantFailureWebSocketFactory(),
          timer,
        );
        const installed = spyOn(manager, "isInstalled").mockResolvedValue(true);
        const running = spyOn(manager, "checkRunningWithReason").mockResolvedValue({ ok: true });
        const cachedClient = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(
          client,
        );
        const commands = [...IOS_RUNNER_FEATURE_COMMANDS, "set_hinge_angle", "set_voiceover_state"];
        const advertised = commands.filter((command) => command !== missing);
        const cachedCommands = spyOn(client, "getCachedSupportedCommands").mockReturnValue(
          advertised,
        );
        const cachedFeatures = spyOn(client, "getCachedSupportedFeatures").mockReturnValue([
          ...IOS_RUNNER_FEATURE_FLAGS,
        ]);
        const requirements = {
          requiredCommands: commands,
          applicability: IOS_RUNNER_COMMAND_APPLICABILITY,
        };
        const environment =
          isVirtual === undefined ? undefined : isVirtual ? "simulator" : "physical";
        const complete =
          missing !== "request_shake" &&
          !(missing === "set_hinge_angle" && isVirtual === true) &&
          !(missing === "set_voiceover_state" && isVirtual === false);
        try {
          const status = await queryDeviceServiceStatus(
            device,
            undefined,
            { getVersion: async () => undefined },
            timer,
            { runnerCommandRequirements: requirements },
          );
          expect(status?.supportedCommandsComplete).toBe(complete);
          expect(status?.isCompatible).toBe(complete);
          // Doctor and the resource share this primitive; missing commands mean stale in both.
          expect(
            getMissingIosRunnerFeatureCommands(new Set(advertised), environment, requirements)
              .length === 0,
          ).toBe(complete);
        } finally {
          installed.mockRestore();
          running.mockRestore();
          cachedClient.mockRestore();
          cachedCommands.mockRestore();
          cachedFeatures.mockRestore();
          await client.close();
          IOSCtrlProxyManager.resetInstances();
        }
      });
    }
  }
});

// A booted iOS simulator entry as the resource builds it from discovery, before service-status
// enrichment. `readiness.unknown` and `capabilities.automation === null` are the freshly-discovered
// defaults; a transient probe failure must leave them untouched (#7053).
function bootedIosDevice(deviceId: string) {
  const description = describeDevice({
    kind: "booted",
    device: { name: "iPhone 15 Pro", platform: "ios", deviceId },
  });
  return {
    ...description,
    recoveryEligibility: null,
    identityUnresolved: false,
  };
}

const readyServiceStatus: DeviceServiceStatus = {
  installed: true,
  enabled: true,
  running: true,
  installedSha256: null,
  expectedSha256: "",
  isCompatible: true,
  version: "0.0.75",
  versionInfo: { build: "0.0.75", source: "ios-runner-bundle" },
  supportedCommandsComplete: true,
  supportedFeaturesComplete: true,
};

const neverSettles: ServiceStatusProbe = () => new Promise<never>(() => {});

describe("booted iOS service-status transient handling (#7053)", () => {
  afterEach(() => {
    setServiceStatusProbe(null);
  });

  test("enrichment preserves simulator and physical environments in probe targets", async () => {
    const observed: (boolean | undefined)[] = [];
    setServiceStatusProbe(async (device) => {
      observed.push(device.isVirtual);
      return readyServiceStatus;
    });
    const devices = [
      { ...bootedIosDevice("SIM-A"), isVirtual: true },
      { ...bootedIosDevice("PHYSICAL-A"), isVirtual: false },
    ];
    await enrichDeviceServiceStatuses(devices, new FakeTimer());
    expect(observed).toEqual([true, false]);
  });

  test("omits iOS version identity when installation is unconfirmed despite a running tunnel", async () => {
    const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
      isInstalled: async () => false,
      isRunning: async () => true,
      checkRunningWithReason: async () => ({ ok: true }),
      getForcedRestartBudget: () => ({ snapshot: () => ({ state: "idle", attempts: 0 }) }),
    } as unknown as IOSCtrlProxyManager);
    try {
      const status = await queryDeviceServiceStatus(
        { name: "iPhone", platform: "ios", deviceId: "SIM-A" },
        undefined,
        { getVersion: async () => ({ build: "0.0.75", source: "ios-runner-bundle" }) },
        new FakeTimer(),
      );
      expect(status?.installed).toBe(false);
      expect(status?.running).toBe(true);
      expect(status).not.toHaveProperty("versionInfo");
      expect(status).not.toHaveProperty("version");
    } finally {
      managerSpy.mockRestore();
    }
  });

  test("a hung service-status probe yields a transient timeout diagnostic, not a settled status", async () => {
    const timer = new FakeTimer();
    const device = bootedIosDevice("SIM-A");
    const outcomePromise = probeServiceStatusWithBudget(
      device,
      neverSettles,
      timer.now() + 5000,
      timer,
    );
    // Fire the bounded wait: the probe never resolves, so the deadline must win.
    timer.advanceTime(5000);
    const outcome = await outcomePromise;

    expect(outcome.status).toBeUndefined();
    expect(outcome.diagnostic).toEqual({
      state: "timeout",
      reason: "Service-status probe did not settle within 5000ms",
    });
  });

  test("a thrown probe (loopback refused/reset) yields a transient unreachable diagnostic", async () => {
    const timer = new FakeTimer();
    const probe: ServiceStatusProbe = () =>
      Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1"));
    const outcome = await probeServiceStatusWithBudget(
      bootedIosDevice("SIM-A"),
      probe,
      timer.now() + 5000,
      timer,
    );

    expect(outcome.status).toBeUndefined();
    expect(outcome.diagnostic?.state).toBe("unreachable");
    expect(outcome.diagnostic?.reason).toContain("ECONNREFUSED");
  });

  test("real iOS status query sends transient health failures to the diagnostic classifier", async () => {
    const installed = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockResolvedValue(true);
    const health = spyOn(IOSCtrlProxyManager.prototype, "checkRunningWithReason");
    const device = { name: "iPhone", platform: "ios" as const, deviceId: "SIM-HEALTH" };
    const timer = new FakeTimer();
    try {
      for (const reason of ["refused", "reset", "timeout"] as const) {
        health.mockResolvedValue({ ok: false, reason });
        const outcome = await probeServiceStatusWithBudget(
          device,
          (target) =>
            queryDeviceServiceStatus(
              target,
              undefined,
              { getVersion: async () => undefined },
              timer,
            ),
          timer.now() + 5000,
          timer,
        );
        expect(outcome.status).toBeUndefined();
        expect(outcome.diagnostic?.state).toBe("unreachable");
        expect(outcome.diagnostic?.reason).toContain(reason);
      }
      health.mockResolvedValue({ ok: false, reason: "unhealthy" });
      const settled = await probeServiceStatusWithBudget(
        device,
        (target) =>
          queryDeviceServiceStatus(target, undefined, { getVersion: async () => undefined }, timer),
        timer.now() + 5000,
        timer,
      );
      expect(settled.diagnostic).toBeUndefined();
      expect(settled.status?.running).toBe(false);
    } finally {
      health.mockRestore();
      installed.mockRestore();
      IOSCtrlProxyManager.resetInstances();
    }
  });

  test("real iOS status query still swallows unrelated manager failures", async () => {
    const installed = spyOn(IOSCtrlProxyManager.prototype, "isInstalled").mockRejectedValue(
      new Error("installation lookup failed"),
    );
    const health = spyOn(IOSCtrlProxyManager.prototype, "checkRunningWithReason").mockResolvedValue(
      {
        ok: true,
      },
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const status = await queryDeviceServiceStatus(
        { name: "iPhone", platform: "ios", deviceId: "SIM-HEALTH" },
        undefined,
        { getVersion: async () => undefined },
        new FakeTimer(),
      );
      expect(status).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("installation lookup failed"));
    } finally {
      warn.mockRestore();
      health.mockRestore();
      installed.mockRestore();
      IOSCtrlProxyManager.resetInstances();
    }
  });

  test("respects the caller deadline budget: an already-elapsed budget returns immediately without probing", async () => {
    const timer = new FakeTimer();
    let probeCalls = 0;
    const probe: ServiceStatusProbe = () => {
      probeCalls++;
      return new Promise<never>(() => {});
    };
    const outcome = await probeServiceStatusWithBudget(
      bootedIosDevice("SIM-A"),
      probe,
      timer.now(),
      timer,
    );

    expect(probeCalls).toBe(0);
    expect(outcome.diagnostic?.state).toBe("timeout");
  });

  test("bounds the wait by the remaining budget, not a fixed default", async () => {
    const timer = new FakeTimer();
    const outcomePromise = probeServiceStatusWithBudget(
      bootedIosDevice("SIM-A"),
      neverSettles,
      timer.now() + 100,
      timer,
    );
    // Only 100ms of budget remains; advancing that far must trip the deadline.
    timer.advanceTime(100);
    const outcome = await outcomePromise;

    expect(outcome.diagnostic).toEqual({
      state: "timeout",
      reason: "Service-status probe did not settle within 100ms",
    });
  });

  test("enrichment keeps a booted simulator in the list with a transient marker when its probe times out", async () => {
    const timer = new FakeTimer();
    setServiceStatusProbe(neverSettles);
    const devices = [bootedIosDevice("SIM-A")];

    const enriched = enrichDeviceServiceStatuses(devices, timer);
    timer.advanceTime(5000);
    await enriched;

    // Present, still one device, still booted — not dropped.
    expect(devices).toHaveLength(1);
    expect(devices[0].runtime.deviceId).toBe("SIM-A");
    expect(devices[0].runtime.lifecycle.state).toBe("booted");
    // Transient marker attached; readiness untouched (never demoted to not_ready).
    expect(devices[0].serviceStatusDiagnostic?.state).toBe("timeout");
    expect(devices[0].runtime.serviceStatus).toBeNull();
    expect("serviceStatus" in devices[0]).toBe(false);
    expect(devices[0].runtime.readiness).toEqual({ state: "unknown" });
  });

  test("two consecutive observations do not flap presence: timeout then success both keep the device present", async () => {
    // Observation 1: probe hangs -> device present with a transient timeout marker.
    const timer1 = new FakeTimer();
    setServiceStatusProbe(neverSettles);
    const devices1 = [bootedIosDevice("SIM-A")];
    const enriched1 = enrichDeviceServiceStatuses(devices1, timer1);
    timer1.advanceTime(5000);
    await enriched1;

    expect(devices1).toHaveLength(1);
    expect(devices1[0].serviceStatusDiagnostic?.state).toBe("timeout");

    // Observation 2: probe recovers -> device still present, now with a real status and no marker.
    const timer2 = new FakeTimer();
    setServiceStatusProbe(async () => readyServiceStatus);
    const devices2 = [bootedIosDevice("SIM-A")];
    await enrichDeviceServiceStatuses(devices2, timer2);

    expect(devices2).toHaveLength(1);
    expect(devices2[0].runtime.deviceId).toBe("SIM-A");
    expect(devices2[0].runtime.serviceStatus).toEqual(readyServiceStatus);
    expect("serviceStatus" in devices2[0]).toBe(false);
    expect(devices2[0].serviceStatusDiagnostic).toBeUndefined();
  });
});
