import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";

const UDID = "00008120-001C2D3E1234567A";
const device: BootedDevice = { deviceId: UDID, platform: "ios", name: "iPhone" };

function makeManager(
  executor: FakeProcessExecutor,
  timer: FakeTimer = new FakeTimer(),
): IOSCtrlProxyManager {
  return IOSCtrlProxyManager.createForTestingWithDeps({
    device,
    timer,
    builder: undefined,
    processExecutor: executor,
  });
}

describe("IOSCtrlProxyManager physical runner tunnel start (#11154)", () => {
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

  describe("Wi-Fi-only devices", () => {
    test("tunnel start is rejected with an actionable error when only `idevice_id -l -n` lists it", async () => {
      const executor = new FakeProcessExecutor();
      executor.setCommandHandler("idevice_id", (command) =>
        createExecResult(command.endsWith("-n") ? `${UDID}\n` : "", ""),
      );
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const manager = makeManager(executor, timer);
      await expect(manager.startIproxyTunnel()).rejects.toThrow(/Wi-Fi only.*USB/);
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
      const manager = makeManager(executor, timer);
      const err = await manager.startIproxyTunnel().catch((e: Error) => e);
      expect(String((err as Error | undefined)?.message ?? "")).not.toMatch(/Wi-Fi only/);
      expect(usbProbes).toBe(2);
    });
  });
});
