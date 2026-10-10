import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { PortManager } from "../../src/utils/PortManager";
import { logger } from "../../src/utils/logger";

const UDID = "00008120-001C2D3E1234567A";
const device: BootedDevice = { deviceId: UDID, platform: "ios", name: "iPhone" };

interface Internals {
  runnerAbortController: AbortController | null;
  xcTestProcessId: number | null;
  stopIproxyTunnel: () => Promise<void>;
  terminateTrackedRunner: () => Promise<unknown>;
}

function makeManager(executor: FakeProcessExecutor): {
  manager: IOSCtrlProxyManager;
  internal: Internals;
} {
  const manager = IOSCtrlProxyManager.createForTestingWithDeps(
    device,
    new FakeTimer(),
    undefined,
    executor,
  );
  return { manager, internal: manager as unknown as Internals };
}

describe("IOSCtrlProxyManager stopTrackedService cleanup (#11154)", () => {
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

  describe("stop", () => {
    test("a throwing tunnel stop still terminates the runner, releases the port and aborts the retiring controller", async () => {
      const executor = new FakeProcessExecutor();
      const { manager, internal } = makeManager(executor);
      const controller = new AbortController();
      internal.runnerAbortController = controller;
      let terminateCalls = 0;
      internal.terminateTrackedRunner = async () => {
        terminateCalls += 1;
        return undefined;
      };
      internal.stopIproxyTunnel = async () => {
        throw new Error("tunnel stop exploded");
      };
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await expect(manager.stop()).rejects.toThrow("tunnel stop exploded");
      } finally {
        warn.mockRestore();
      }
      expect(terminateCalls).toBe(1);
      expect(controller.signal.aborted).toBe(true);
      expect(PortManager.getPort(UDID)).toBeUndefined();
    });
  });
});
