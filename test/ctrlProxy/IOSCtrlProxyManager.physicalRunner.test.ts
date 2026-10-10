import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";
import { logger } from "../../src/utils/logger";
import type { IosPhysicalDeviceLister } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import type { PhysicalIosDeviceDiscovery } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";

const UDID = "00008120-001C2D3E1234567A";
const device: BootedDevice = { deviceId: UDID, platform: "ios", name: "iPhone" };

function listerReturning(discovery: PhysicalIosDeviceDiscovery): IosPhysicalDeviceLister {
  return { listConnectedDevices: async () => discovery };
}

interface Internals {
  isDeviceDetected(): Promise<boolean>;
  startIproxyTunnel(): Promise<void>;
  runnerAbortController: AbortController | null;
  xcTestProcessId: number | null;
  stopIproxyTunnel: () => Promise<void>;
  terminateTrackedRunner: () => Promise<unknown>;
}

function makeManager(
  executor: FakeProcessExecutor,
  lister?: IosPhysicalDeviceLister,
  timer: FakeTimer = new FakeTimer(),
): { manager: IOSCtrlProxyManager; internal: Internals } {
  const manager = IOSCtrlProxyManager.createForTestingWithDeps(
    device,
    timer,
    undefined,
    executor,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lister,
  );
  return { manager, internal: manager as unknown as Internals };
}

describe("IOSCtrlProxyManager physical runner detection and stop (#11154)", () => {
  beforeEach(() => {
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });

  afterEach(() => {
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  describe("isDeviceDetected", () => {
    test("a USB listing is sufficient", async () => {
      const executor = new FakeProcessExecutor();
      executor.setCommandResponse("idevice_id -l", createExecResult(`${UDID}\n`, ""));
      const { internal } = makeManager(executor);
      expect(await internal.isDeviceDetected()).toBe(true);
    });

    test("an idevice_id miss is not disconnect evidence while devicectl still lists the device", async () => {
      const executor = new FakeProcessExecutor();
      const { internal } = makeManager(
        executor,
        listerReturning({ devices: [device], complete: true }),
      );
      expect(await internal.isDeviceDetected()).toBe(true);
    });

    test("an incomplete devicectl listing is not authoritative", async () => {
      const executor = new FakeProcessExecutor();
      const { internal } = makeManager(
        executor,
        listerReturning({
          devices: [],
          complete: false,
          error: { code: "failed", message: "devicectl blip" },
        }),
      );
      expect(await internal.isDeviceDetected()).toBe(true);
    });

    test("absent from both idevice_id and a complete devicectl listing means gone", async () => {
      const executor = new FakeProcessExecutor();
      const { internal } = makeManager(executor, listerReturning({ devices: [], complete: true }));
      expect(await internal.isDeviceDetected()).toBe(false);
    });

    test("warns once when idevice_id cannot run, then falls back to devicectl", async () => {
      const executor = new FakeProcessExecutor();
      executor.setCommandHandler("idevice_id", () => {
        throw new Error("spawn idevice_id ENOENT");
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { internal } = makeManager(
          executor,
          listerReturning({ devices: [device], complete: true }),
        );
        expect(await internal.isDeviceDetected()).toBe(true);
        expect(await internal.isDeviceDetected()).toBe(true);
        const probeWarnings = warn.mock.calls.filter(([line]) =>
          String(line).includes("idevice_id probe failed"),
        );
        expect(probeWarnings).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("Wi-Fi-only devices", () => {
    test("tunnel start is rejected with an actionable error when only `idevice_id -l -n` lists it", async () => {
      const executor = new FakeProcessExecutor();
      executor.setCommandHandler("idevice_id", (command) =>
        createExecResult(command.endsWith("-n") ? `${UDID}\n` : "", ""),
      );
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const { internal } = makeManager(executor, undefined, timer);
      await expect(internal.startIproxyTunnel()).rejects.toThrow(/Wi-Fi only.*USB/);
      expect(executor.getSpawnedProcesses()).toEqual([]);
    });

    test("a transient `idevice_id -l` miss is retried once before rejecting as Wi-Fi only (#11186)", async () => {
      const executor = new FakeProcessExecutor();
      let usbProbes = 0;
      executor.setCommandHandler("idevice_id", (command) => {
        if (command.endsWith("-n")) {
          return createExecResult(`${UDID}\n`, "");
        }
        usbProbes += 1;
        return createExecResult(usbProbes === 1 ? "" : `${UDID}\n`, "");
      });
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const { internal } = makeManager(executor, undefined, timer);
      const err = await internal.startIproxyTunnel().catch((e: Error) => e);
      expect(String((err as Error | undefined)?.message ?? "")).not.toMatch(/Wi-Fi only/);
      expect(usbProbes).toBe(2);
    });
  });
});
