import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { PortManager } from "../../src/utils/PortManager";
import { logger } from "../../src/utils/logger";
import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeIosTunnelClient } from "../fakes/FakeIosTunnelClient";
import type { HostChildProcess } from "../../src/utils/HostCommandExecutor";

const UDID = "00008120-001C2D3E1234567A";
const device: BootedDevice = { deviceId: UDID, platform: "ios", name: "iPhone" };

function makeManager(
  executor: FakeProcessExecutor,
  processClient?: IosCtrlProxyProcessClient,
): IOSCtrlProxyManager {
  return IOSCtrlProxyManager.createForTestingWithOptions({
    device,
    timer: new FakeTimer(),
    processExecutor: executor,
    processClient,
    steps: { isOwnRunnerProcessAlive: async () => true },
  });
}

describe("IOSCtrlProxyManager stopTrackedService cleanup (#11154)", () => {
  const restores: Array<() => void> = [];
  beforeEach(() => {
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });

  afterEach(() => {
    for (const restore of restores.splice(0)) {
      restore();
    }
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  describe("stop", () => {
    test.each(["hung", "stop", "replacement", "shutdown"] as const)(
      "passes the launch generation when terminating the recorded runner for %s",
      async (site) => {
        const executor = new FakeProcessExecutor();
        const timer = new FakeTimer();
        const generation = new FakeLockOwnerGenerationProbe();
        generation.token = "launch-token";
        const client = new IosCtrlProxyProcessClient(executor, timer, {
          processGeneration: generation,
        });
        const manager = makeManager(executor, client);
        const child = new FakeChildProcess(timer);
        manager.trackStartedXcodebuild(child as HostChildProcess);
        expect(generation.currentCalls).toEqual([child.pid!]);
        generation.token = "later-token";
        const terminate = spyOn(client, "terminateProcessTree").mockResolvedValue(undefined);
        const owned = spyOn(client, "checkRunnerOwnership").mockResolvedValue("owned");
        restores.push(
          () => terminate.mockRestore(),
          () => owned.mockRestore(),
        );

        if (site === "hung") {
          await manager.terminateHungRunnerProcess(child.pid!);
        } else if (site === "stop") {
          await manager.terminateTrackedRunner(null, 250);
        } else if (site === "shutdown") {
          await manager.forceStopForShutdown(250);
        } else {
          await manager.retireTrackedDeviceRunnerBeforeSpawn();
        }

        expect(terminate).toHaveBeenCalledWith(
          child.pid!,
          site === "stop" || site === "shutdown" ? 250 : undefined,
          site === "shutdown"
            ? {
                expectedGenerationToken: "launch-token",
                expectedDeviceId: UDID,
                preKillDeadlineMs: 200,
                skipGraceful: true,
              }
            : { expectedGenerationToken: "launch-token" },
        );
        if (site !== "hung") {
          expect(manager.diagnostics.hasRunnerGenerationToken(child.pid!)).toBe(false);
        }
      },
    );

    test.each([
      ["adopted", "hung"],
      ["started", "hung"],
      ["adopted", "shutdown"],
      ["started", "shutdown"],
    ] as const)(
      "does not capture or pass a local generation for a %s remote runner during %s",
      async (mode, site) => {
        const executor = new FakeProcessExecutor();
        const generation = new FakeLockOwnerGenerationProbe();
        const client = new IosCtrlProxyProcessClient(executor, new FakeTimer(), {
          processGeneration: generation,
        });
        const manager = makeManager(executor, client);
        const remote = manager.diagnostics.remoteRunner;
        const mocks = [
          spyOn(remote, "isEnabled").mockReturnValue(true),
          spyOn(remote, "isRunningInDocker").mockReturnValue(true),
          spyOn(remote, "isAvailable").mockResolvedValue(true),
          spyOn(manager, "ensureRemoteServicePortAvailable").mockResolvedValue(undefined),
          spyOn(manager.diagnostics.builder, "getXctestrunPath").mockResolvedValue(null),
          spyOn(remote, "status").mockResolvedValue({
            success: true,
            data: { running: mode === "adopted", pid: 42, port: 8101 },
          }),
          spyOn(remote, "start").mockResolvedValue({
            success: true,
            data: { pid: 42, message: "started", port: 8101 },
          }),
        ];
        const terminate = spyOn(client, "terminateProcessTree").mockResolvedValue(undefined);
        const stop = spyOn(remote, "stop").mockResolvedValue({ success: true });
        restores.push(
          ...mocks.map((mock) => () => mock.mockRestore()),
          () => terminate.mockRestore(),
          () => stop.mockRestore(),
        );

        await manager.startOnSimulator();
        expect(manager.diagnostics.xcTestProcessId).toBe(42);
        expect(generation.currentCalls).toEqual([]);
        expect(manager.diagnostics.hasRunnerGenerationToken(42)).toBe(false);
        if (site === "shutdown") {
          await manager.forceStopForShutdown(250);
        } else {
          await manager.terminateHungRunnerProcess(42);
        }
        expect(stop).toHaveBeenCalledWith({ deviceId: UDID, pid: 42 });
        expect(terminate).not.toHaveBeenCalled();
      },
    );

    test("a throwing tunnel stop still terminates the runner and aborts the retiring controller but retains the port reservation (#11186)", async () => {
      const tunnelClient = new FakeIosTunnelClient();
      tunnelClient.stopError = new Error("tunnel stop exploded");
      let terminateCalls = 0;
      const manager = IOSCtrlProxyManager.createForTestingWithOptions({
        device,
        timer: new FakeTimer(),
        processExecutor: new FakeProcessExecutor(),
        tunnelClient,
        steps: {
          terminateTrackedRunner: async () => {
            terminateCalls += 1;
            return undefined;
          },
        },
      });
      PortManager.reserve(UDID, 8101);
      const controller = new AbortController();
      manager.testHooks.trackRunner({ pid: null, abortController: controller });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await expect(manager.stop()).rejects.toThrow("tunnel stop exploded");
      } finally {
        warn.mockRestore();
      }
      expect(terminateCalls).toBe(1);
      expect(controller.signal.aborted).toBe(true);
      expect(PortManager.getPort(UDID)).toBe(8101);
    });
  });
});
