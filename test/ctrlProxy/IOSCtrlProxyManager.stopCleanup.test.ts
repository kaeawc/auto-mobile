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
import type { HostChildProcess } from "../../src/utils/HostCommandExecutor";

const UDID = "00008120-001C2D3E1234567A";
const device: BootedDevice = { deviceId: UDID, platform: "ios", name: "iPhone" };

interface Internals {
  runnerAbortController: AbortController | null;
  xcTestProcessId: number | null;
  stopIproxyTunnel: () => Promise<void>;
  terminateTrackedRunner: () => Promise<unknown>;
}

function makeManager(
  executor: FakeProcessExecutor,
  processClient?: IosCtrlProxyProcessClient,
): {
  manager: IOSCtrlProxyManager;
  internal: Internals;
} {
  const manager = IOSCtrlProxyManager.createForTestingWithDeps(
    device,
    new FakeTimer(),
    undefined,
    executor,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    processClient,
  );
  return { manager, internal: manager as unknown as Internals };
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
        const { manager } = makeManager(executor, client);
        const child = new FakeChildProcess(timer);
        manager["trackStartedXcodebuild"](child as HostChildProcess);
        expect(generation.currentCalls).toEqual([child.pid!]);
        generation.token = "later-token";
        const terminate = spyOn(client, "terminateProcessTree").mockResolvedValue(undefined);
        const alive = spyOn(manager, "isOwnRunnerProcessAlive").mockResolvedValue(true);
        const local = spyOn(manager, "useRemoteRunner").mockReturnValue(false);
        const owned = spyOn(manager, "isRunnerStillOwnedWithinShutdownDeadline").mockResolvedValue(
          true,
        );
        restores.push(
          () => terminate.mockRestore(),
          () => alive.mockRestore(),
          () => local.mockRestore(),
          () => owned.mockRestore(),
        );

        if (site === "hung") {
          await manager["terminateHungRunnerProcess"](child.pid!);
        } else if (site === "stop") {
          await manager["terminateTrackedRunner"](null, 250);
        } else if (site === "shutdown") {
          await manager["forceStopForShutdown"](250);
        } else {
          await manager["retireTrackedDeviceRunnerBeforeSpawn"]();
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
          expect(manager["runnerGenerationTokens"].has(child.pid!)).toBe(false);
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
        const { manager } = makeManager(executor, client);
        const remote = manager["remoteRunner"];
        const mocks = [
          spyOn(manager, "useRemoteRunner").mockReturnValue(true),
          spyOn(manager, "isRemoteRunnerAvailable").mockResolvedValue(true),
          spyOn(manager, "ensureRemoteServicePortAvailable").mockResolvedValue(undefined),
          spyOn(manager["builder"], "getXctestrunPath").mockResolvedValue(null),
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

        await manager["startOnSimulator"]();
        expect(manager["xcTestProcessId"]).toBe(42);
        expect(generation.currentCalls).toEqual([]);
        expect(manager["runnerGenerationTokens"].has(42)).toBe(false);
        if (site === "shutdown") {
          await manager["forceStopForShutdown"](250);
        } else {
          await manager["terminateHungRunnerProcess"](42);
        }
        expect(stop).toHaveBeenCalledWith({ deviceId: UDID, pid: 42 });
        expect(terminate).not.toHaveBeenCalled();
      },
    );

    test("a throwing tunnel stop still terminates the runner and aborts the retiring controller but retains the port reservation (#11186)", async () => {
      const executor = new FakeProcessExecutor();
      const { manager, internal } = makeManager(executor);
      PortManager.reserve(UDID, 8101);
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
      expect(PortManager.getPort(UDID)).toBe(8101);
    });
  });
});
