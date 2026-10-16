import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  IOSCtrlProxyManager,
  STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS,
  MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES,
} from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { logger } from "../../src/utils/logger";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import type { Xcodebuild } from "../../src/utils/ios-cmdline-tools/XcodebuildClient";
import { parsePlist } from "../../src/utils/ios-cmdline-tools/XctestrunPlist";
import type { XcodeSigningManager } from "../../src/utils/ios-cmdline-tools/XcodeSigning";
import * as fs from "fs/promises";
import * as path from "path";
import os from "os";
import {
  BOUNDARY_XCTESTRUN,
  FakeListeningProcess,
  createFakeBuilder,
  deferred,
  flushUntil,
  installIosManagerSuiteHooks,
  installListeningProcessFakes,
} from "../helpers/iosCtrlProxyManagerHarness";
import {
  asIosCtrlProxyBuilder,
  createReusedRunnerBuilder,
  createStartableBuilder,
  fakeWriteRunnerEnvironment,
} from "../helpers/iosCtrlProxyBuilderFake";

describe("IOSCtrlProxyManager simulator start", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;

  installIosManagerSuiteHooks((ctx) => {
    testDevice = ctx.testDevice;
    fakeTimer = ctx.fakeTimer;
  });

  describe("simulator start uses xcodebuild test-without-building", function () {
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function () {
      fakeExecutor = new FakeProcessExecutor();
    });

    test("start() throws when simulator xctestrun path is missing", async function () {
      const fakeBuilder = createStartableBuilder(null);

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
      );

      // Health check fails → not already running → tries to start
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy xctestrun not found for simulator");
    });

    test("start() does not use simctl spawn for simulator", async function () {
      const fakeBuilder = createStartableBuilder("/tmp/test.xctestrun");

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
      );

      // Health check succeeds on first poll (simulating xcodebuild starting the service)
      fakeExecutor.setCommandResponse(
        "curl -s",
        createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
      );
      fakeTimer.enableAutoAdvance();

      await manager.start();

      // simctl spawn should never be invoked via processExecutor
      expect(fakeExecutor.wasCommandExecuted("simctl spawn")).toBe(false);
    });

    test("start() adopts a healthy default hot-reload CtrlProxy port before health polling", async function () {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = createReusedRunnerBuilder();
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
        );
        expect(manager.getServicePort()).toBe(8767);

        fakeExecutor.setCommandResponse("http://127.0.0.1:8767/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
        fakeExecutor.setCommandResponse(
          "http://127.0.0.1:8765/health",
          createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
        );
        fakeTimer.enableAutoAdvance();

        await manager.start();

        expect(manager.getServicePort()).toBe(8765);
        expect(PortManager.getPort(testDevice.deviceId)).toBe(8765);
        expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test.each(["OTHER-SIMULATOR", undefined])(
      "start() rejects ambiguous default-port identity: %s",
      async function (deviceId) {
        PortManager.setPortAvailabilityCheckerForTesting({
          isPortAvailable: (port: number) => port !== 8765,
        });
        try {
          const fakeBuilder = createStartableBuilder("/tmp/test.xctestrun");
          const manager = IOSCtrlProxyManager.createForTestingWithDeps(
            testDevice,
            fakeTimer,
            fakeBuilder,
            fakeExecutor,
          );
          expect(manager.getServicePort()).toBe(8767);

          fakeExecutor.setCommandResponse("http://127.0.0.1:8767/health", createExecResult("", ""));
          fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
          fakeExecutor.setCommandResponse(
            "http://127.0.0.1:8765/health",
            createExecResult(JSON.stringify({ status: "ok", deviceId }), ""),
          );
          fakeTimer.enableAutoAdvance();

          await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

          expect(manager.getServicePort()).toBe(8767);
          expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
          expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
        } finally {
          PortManager.setPortAvailabilityCheckerForTesting(null);
        }
      },
    );

    test("start() spawns when default hot-reload port is not healthy", async function () {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = createStartableBuilder("/tmp/test.xctestrun");
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
        );

        fakeExecutor.setCommandResponse("http://127.0.0.1:8767/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
        fakeExecutor.setCommandResponse("http://127.0.0.1:8765/health", createExecResult("", ""));
        fakeTimer.enableAutoAdvance();

        await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

        expect(manager.getServicePort()).toBe(8767);
        expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("start() adopts a custom hot-reload CtrlProxy port from process args", async function () {
      const fakeBuilder = createReusedRunnerBuilder();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse("http://127.0.0.1:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2469\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2469",
        createExecResult(
          `xcodebuild test CtrlProxyUITests -destination id=${testDevice.deviceId} CTRL_PROXY_IOS_PORT=8790`,
          "",
        ),
      );
      fakeExecutor.setCommandResponse(
        "http://127.0.0.1:8790/health",
        createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
      );
      fakeTimer.enableAutoAdvance();

      await manager.start();

      expect(manager.getServicePort()).toBe(8790);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8790);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() adopts a healthy direct runner on an unallocated custom port when listener lookup misses it", async function () {
      const runnerProcess: FakeListeningProcess = {
        pid: 2473,
        port: 8790,
        ppid: 2468,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        environment: `CTRL_PROXY_IOS_PORT=8790 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const simulatorProcess: FakeListeningProcess = {
        pid: 2468,
        port: 0,
        ppid: 1,
        command: `launchd_sim ${testDevice.deviceId}`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [runnerProcess, simulatorProcess]);
      fakeExecutor.setCommandHandler("lsof -nP -iTCP:", () => createExecResult("", ""));
      const fakeBuilder = asIosCtrlProxyBuilder({
        getXctestrunPath: async () => {
          throw new Error("should not build when a healthy direct runner is reused");
        },
        getRunnerBinaryPath: async () => null,
        verifyRunnerBinaryBeforeLaunch: async () => {},
        writeRunnerEnvironment: fakeWriteRunnerEnvironment,
      });
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse("http://127.0.0.1:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse(
        "http://127.0.0.1:8790/health",
        createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
      );
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("2473\n", ""));
      fakeTimer.enableAutoAdvance();

      await manager.start();

      expect(manager.getServicePort()).toBe(8790);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8790);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() does not adopt a direct runner whose health identifies another simulator", async function () {
      const runnerProcess: FakeListeningProcess = {
        pid: 2474,
        port: 8790,
        ppid: 2468,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        environment: "CTRL_PROXY_IOS_PORT=8790 AUTOMOBILE_DEVICE_ID=OTHER-SIMULATOR",
        alive: true,
      };
      const simulatorProcess: FakeListeningProcess = {
        pid: 2468,
        port: 0,
        ppid: 1,
        command: "launchd_sim OTHER-SIMULATOR",
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [runnerProcess, simulatorProcess]);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse(
        "http://127.0.0.1:8790/health",
        createExecResult(JSON.stringify({ status: "ok", deviceId: "OTHER-SIMULATOR" }), ""),
      );
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("2474\n", ""));
      fakeExecutor.setCommandHandler("curl -s", (command) => {
        const port = Number(command.match(/127\.0\.0\.1:(\d+)\/health/)?.[1]);
        return createExecResult(
          port === 8790
            ? JSON.stringify({ status: "ok", deviceId: "OTHER-SIMULATOR" })
            : fakeExecutor.getSpawnedProcesses().length > 0
              ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
              : "",
          "",
        );
      });
      fakeTimer.enableAutoAdvance();

      await manager.start();

      expect(manager.getServicePort()).toBe(8765);
      expect(runnerProcess.alive).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("start() does not adopt a healthy direct runner rooted at an orphaned daemon process", async function () {
      const orphanedRunner: FakeListeningProcess = {
        pid: 2475,
        port: 8790,
        ppid: 1,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        environment: `CTRL_PROXY_IOS_PORT=8790 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [orphanedRunner]);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("2475\n", ""));
      fakeExecutor.setCommandHandler("curl -s", (command) => {
        const port = Number(command.match(/127\.0\.0\.1:(\d+)\/health/)?.[1]);
        return createExecResult(
          port === 8790
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : fakeExecutor.getSpawnedProcesses().length > 0
              ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
              : "",
          "",
        );
      });
      fakeTimer.enableAutoAdvance();

      await manager.start();

      expect(manager.getServicePort()).toBe(8765);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("start() bounds health probes for direct-runner candidates", async function () {
      const simulatorProcess: FakeListeningProcess = {
        pid: 2468,
        port: 0,
        ppid: 1,
        command: `launchd_sim ${testDevice.deviceId}`,
        alive: true,
      };
      const candidateProcesses = Array.from(
        { length: MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES + 1 },
        (_, index): FakeListeningProcess => ({
          pid: 2500 + index,
          port: 8800 + index,
          ppid: simulatorProcess.pid,
          command:
            "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
          environment: `CTRL_PROXY_IOS_PORT=${8800 + index} AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
          alive: true,
        }),
      );
      installListeningProcessFakes(fakeExecutor, [simulatorProcess, ...candidateProcesses]);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );
      let customPortHealthProbeCount = 0;

      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(candidateProcesses.map((process) => String(process.pid)).join("\n"), ""),
      );
      fakeExecutor.setCommandHandler("curl -s", (command) => {
        const port = Number(command.match(/127\.0\.0\.1:(\d+)\/health/)?.[1]);
        if (port >= 8800 && port <= 8800 + MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES) {
          customPortHealthProbeCount++;
          return createExecResult("", "");
        }
        return createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        );
      });
      fakeTimer.enableAutoAdvance();

      await manager.start();

      expect(customPortHealthProbeCount).toBe(MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("start() filters non-runner candidates before applying the direct-runner probe cap", async function () {
      const simulatorProcess: FakeListeningProcess = {
        pid: 2468,
        port: 0,
        ppid: 1,
        command: `launchd_sim ${testDevice.deviceId}`,
        alive: true,
      };
      const unrelatedProcesses = Array.from(
        { length: MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES },
        (_, index): FakeListeningProcess => ({
          pid: 2600 + index,
          port: 0,
          ppid: 1,
          command: `xcodebuild CtrlProxy unrelated-process-${index}`,
          alive: true,
        }),
      );
      const runnerProcess: FakeListeningProcess = {
        pid: 2700,
        port: 8790,
        ppid: simulatorProcess.pid,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        environment: `CTRL_PROXY_IOS_PORT=8790 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [
        simulatorProcess,
        ...unrelatedProcesses,
        runnerProcess,
      ]);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(
          [...unrelatedProcesses, runnerProcess].map((process) => String(process.pid)).join("\n"),
          "",
        ),
      );
      fakeExecutor.setCommandHandler("curl -s", (command) => {
        const port = Number(command.match(/127\.0\.0\.1:(\d+)\/health/)?.[1]);
        return createExecResult(
          port === runnerProcess.port
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        );
      });
      fakeTimer.enableAutoAdvance();

      await manager.start();

      expect(manager.getServicePort()).toBe(runnerProcess.port);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() preserves an externally managed runner on the current port while it is still starting", async function () {
      const externalProcess: FakeListeningProcess = {
        pid: 2470,
        port: 8765,
        command: `xcodebuild test CtrlProxyUITests -destination id=${testDevice.deviceId} CTRL_PROXY_IOS_PORT=8765`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [externalProcess]);
      const fakeBuilder = createReusedRunnerBuilder();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse("http://127.0.0.1:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2470\n", ""));
      fakeExecutor.setCommandResponse("ps -p 2470", createExecResult(externalProcess.command, ""));
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(externalProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2470")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2470")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() preserves an externally managed test-without-building runner with inline identity", async function () {
      const externalProcess: FakeListeningProcess = {
        pid: 2471,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [externalProcess]);
      const fakeBuilder = createReusedRunnerBuilder();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse("http://127.0.0.1:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2471\n", ""));
      fakeExecutor.setCommandResponse("ps -p 2471", createExecResult(externalProcess.command, ""));
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(externalProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2471")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2471")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() preserves an externally managed test-without-building runner with environment identity", async function () {
      const externalProcess: FakeListeningProcess = {
        pid: 2472,
        port: 8791,
        ppid: 2468,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8791 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [externalProcess]);
      const fakeBuilder = createReusedRunnerBuilder();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse("http://127.0.0.1:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("http://127.0.0.1:8791/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2472\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2472",
        createExecResult(`${externalProcess.ppid} ${externalProcess.command}`, ""),
      );
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(externalProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2472")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2472")).toBe(false);
      expect(manager.getServicePort()).toBe(8791);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8791);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("start() ignores xcodebuild CtrlProxy processes for other simulators", async function () {
      const fakeBuilder = createStartableBuilder("/tmp/test.xctestrun");
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
      );

      fakeExecutor.setCommandResponse("http://127.0.0.1:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2469\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2469",
        createExecResult(
          "xcodebuild test CtrlProxyUITests -destination id=OTHER-SIMULATOR CTRL_PROXY_IOS_PORT=8790",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(manager.getServicePort()).toBe(8765);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("supervisor health restart spawns for its simulator without adopting or killing a sibling runner", async function () {
      const otherRunner: FakeListeningProcess = {
        pid: 2469,
        port: 8790,
        command:
          "xcodebuild test CtrlProxyUITests -destination id=OTHER-SIMULATOR CTRL_PROXY_IOS_PORT=8790",
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [otherRunner]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2469\n", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );
      const supervisor = (manager as unknown as { processSupervisor: { start(): Promise<void> } })
        .processSupervisor;

      await supervisor.start();
      fakeTimer.advanceTime(30_000);
      await flushUntil(() => supervisor.isRestartPending(), "the health-check restart schedule");
      fakeTimer.advanceTime(2_000);
      await flushUntil(() => fakeExecutor.getSpawnedProcesses().length > 0, "the runner restart");

      const launches = fakeExecutor.getSpawnedProcesses();
      expect(launches).toHaveLength(1);
      expect(launches[0].command).toBe("xcodebuild");
      expect(launches[0].args).toContain(`platform=iOS Simulator,id=${testDevice.deviceId}`);
      expect(launches[0].args.join(" ")).not.toContain("OTHER-SIMULATOR");
      expect(otherRunner.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2469")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2469")).toBe(false);
      expect(manager.getServicePort()).toBe(8765);
    });

    test("startOnSimulator() delivers the reallocated port to the runner via the xctestrun (EC5)", async function () {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const writeCalls: {
          xctestrunPath: string;
          env: Record<string, string>;
          deviceId: string;
        }[] = [];
        const fakeBuilder = asIosCtrlProxyBuilder({
          getXctestrunPath: async () => "/tmp/test.xctestrun",
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: async (
            xctestrunPath: string,
            env: Record<string, string>,
            deviceId: string,
          ) => {
            writeCalls.push({ xctestrunPath, env, deviceId });
            return "/tmp/automobile-runner-SIM.xctestrun";
          },
        });
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
        );

        await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

        const spawn = fakeExecutor.getSpawnedProcesses()[0];
        expect(manager.getServicePort()).toBe(8767);

        // The allocated port is injected into the xctestrun (the only channel the
        // in-simulator runner can read) — keyed off the cached source xctestrun.
        expect(writeCalls).toHaveLength(1);
        expect(writeCalls[0].xctestrunPath).toBe("/tmp/test.xctestrun");
        expect(writeCalls[0].env.CTRL_PROXY_IOS_PORT).toBe("8767");
        expect(writeCalls[0].deviceId).toBe(testDevice.deviceId);

        // xcodebuild is pointed at the per-launch copy, not the cached source.
        expect(spawn.command).toBe("xcodebuild");
        expect(spawn.args).toContain("/tmp/automobile-runner-SIM.xctestrun");
        expect(spawn.args).not.toContain("/tmp/test.xctestrun");
        expect(spawn.options?.shell).toBe(false);

        // Host env still carries the identity vars used for daemon-side process
        // discovery/ownership — but NOT the dead SIMCTL_CHILD_* prefixes.
        expect(spawn.options?.env).toMatchObject({
          CTRL_PROXY_IOS_PORT: "8767",
          AUTOMOBILE_DEVICE_ID: testDevice.deviceId,
        });
        expect(
          Object.keys(spawn.options?.env ?? {}).some((key) => key.startsWith("SIMCTL_CHILD_")),
        ).toBe(false);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("startOnSimulator() gives the resident runner its own process signal, not the ambient request signal (issue #6410)", async function () {
      // The runner is a shared, long-lived resident process serving every session
      // targeting this device. Binding its OS-level kill to whichever MCP
      // request happened to start it would let an unrelated request cancellation
      // SIGTERM a runner that is already healthy and serving other work.
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = createStartableBuilder("/tmp/test.xctestrun");
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
        );

        const ambientRequestController = new AbortController();
        await runWithAbortSignal(ambientRequestController.signal, () =>
          (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator(),
        );

        const spawn = fakeExecutor.getSpawnedProcesses()[0];
        expect(spawn.options?.signal).toBeDefined();
        expect(spawn.options?.signal).not.toBe(ambientRequestController.signal);

        // Cancelling the ambient request that started the runner must not reach
        // the runner's own lifecycle controller.
        ambientRequestController.abort();
        expect(spawn.options?.signal?.aborted).toBe(false);

        const tracked = manager as unknown as {
          xcTestProcessId: number | null;
          processClient: IosCtrlProxyProcessClient;
        };
        const pid = tracked.xcTestProcessId!;
        (
          manager as unknown as { isOwnRunnerProcessAlive: () => Promise<boolean> }
        ).isOwnRunnerProcessAlive = async () => true;
        let terminated = false;
        tracked.processClient.terminateProcessTree = async (target) => {
          expect(target).toBe(pid);
          expect(spawn.options?.signal?.aborted).toBe(false);
          terminated = true;
        };
        spawn.options?.signal?.addEventListener("abort", () => {
          expect(terminated).toBe(true);
          tracked.xcTestProcessId = null;
        });
        await manager.stop();
        expect(terminated).toBe(true);
        expect(spawn.options?.signal?.aborted).toBe(true);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("startOnSimulator() reallocates when the current simulator port becomes busy before launch", async function () {
      const unavailablePorts = new Set<number>();
      const checkedPorts: number[] = [];
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => {
          checkedPorts.push(port);
          return !unavailablePorts.has(port);
        },
      });
      try {
        const fakeBuilder = createStartableBuilder("/tmp/test.xctestrun");
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
        );
        expect(manager.getServicePort()).toBe(8765);

        unavailablePorts.add(8765);

        await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

        const spawn = fakeExecutor.getSpawnedProcesses()[0];
        expect(checkedPorts).toEqual([8765, 8765, 8767]);
        expect(manager.getServicePort()).toBe(8767);
        expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
        expect(spawn.options?.env).toMatchObject({
          CTRL_PROXY_IOS_PORT: "8767",
        });
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("the port the runner reads from the spawned xctestrun equals the client service port (EC6 boundary)", async function () {
      // Boundary model of the simulator process boundary: the daemon (client) and
      // the in-simulator runner agree on the port ONLY if the allocated port is
      // carried in the xctestrun the runner reads. This is the assertion that
      // would have caught #2731 (runner bound 8765 while the client used 8767).
      const productsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlproxy-boundary-"));
      const sourceXctestrun = path.join(
        productsDir,
        "AutoMobileTest_iphonesimulator26.2-arm64-x86_64.xctestrun",
      );
      await fs.writeFile(sourceXctestrun, BOUNDARY_XCTESTRUN);

      // Use the REAL writeRunnerEnvironment so a real per-launch xctestrun is produced.
      const realBuilder = IosCtrlProxyBuilder.getInstance({ derivedDataPath: productsDir });
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = asIosCtrlProxyBuilder({
          getXctestrunPath: async () => sourceXctestrun,
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: (p: string, env: Record<string, string>, id: string) =>
            realBuilder.writeRunnerEnvironment(p, env, id),
        });
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
        );

        await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

        // Read back the port the runner WILL read from its own ProcessInfo.environment.
        const spawnArgs = fakeExecutor.getSpawnedProcesses()[0].args;
        const xctestrunArgIndex = spawnArgs.indexOf("-xctestrun");
        expect(xctestrunArgIndex).toBeGreaterThanOrEqual(0);
        const runnerXctestrunPath = spawnArgs[xctestrunArgIndex + 1];
        const root = (await parsePlist(await fs.readFile(runnerXctestrunPath, "utf-8"))) as Map<
          string,
          unknown
        >;
        const uiTarget = root.get("CtrlProxyUITests") as Map<string, unknown>;
        const env = uiTarget.get("EnvironmentVariables") as Map<string, unknown>;
        const runnerPort = Number(env.get("CTRL_PROXY_IOS_PORT"));

        expect(runnerPort).toBe(8767);
        expect(runnerPort).toBe(manager.getServicePort());
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
        await fs.rm(productsDir, { recursive: true, force: true });
      }
    });

    test.each([false, true])(
      "device launch verifies before xcodebuild and fails closed (%s)",
      async (rejectVerification) => {
        const physicalDevice: BootedDevice = {
          deviceId: "00008030001E28C11E",
          platform: "ios",
          name: "iPhone",
        };
        const events: string[] = [];
        const builder = createFakeBuilder();
        builder.getXctestrunPath = async (platform) => {
          events.push(`xctestrun:${platform}`);
          return "/tmp/device.xctestrun";
        };
        builder.verifyRunnerBinaryBeforeLaunch = async (platform) => {
          events.push(`verify:${platform}`);
          if (rejectVerification) {
            throw new Error("runner verification rejected");
          }
        };
        const signing = {
          resolveSigningForDevice: async () => ({
            buildSettings: [],
            allowProvisioningUpdates: false,
            warnings: [],
          }),
        } as unknown as XcodeSigningManager;
        const xcodebuild: Xcodebuild = {
          executeCommand: async () => createExecResult("", ""),
          isAvailable: async () => true,
          startStreaming: async () => {
            events.push("spawn");
            return new FakeChildProcess(fakeTimer) as unknown as ChildProcess;
          },
        };
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice,
          fakeTimer,
          builder,
          fakeExecutor,
          signing,
          undefined,
          undefined,
          undefined,
          xcodebuild,
        );
        const internal = manager as unknown as {
          startOnDevice: () => Promise<void>;
          startIproxyTunnel: () => Promise<void>;
          assertTunnelForwardsServicePort: () => void;
          verifyInstalledAppBundle: () => Promise<void>;
        };
        internal.startIproxyTunnel = async () => {};
        // The tunnel is stubbed out, so there is no forwarded port to compare (#10232).
        internal.assertTunnelForwardsServicePort = () => {};
        internal.verifyInstalledAppBundle = async () => {};
        if (rejectVerification) {
          await expect(internal.startOnDevice()).rejects.toThrow("runner verification rejected");
          expect(events).toEqual(["xctestrun:device", "verify:device"]);
        } else {
          await internal.startOnDevice();
          expect(events).toEqual(["xctestrun:device", "verify:device", "spawn"]);
        }
      },
    );

    test("startOnDevice() delivers the allocated port via the xctestrun, not a build setting (EC7)", async function () {
      const physicalDevice: BootedDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone",
      };
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const writeCalls: { env: Record<string, string>; deviceId: string }[] = [];
        const fakeBuilder = asIosCtrlProxyBuilder({
          getXctestrunPath: async () => "/tmp/device.xctestrun",
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: async (
            _p: string,
            env: Record<string, string>,
            deviceId: string,
          ) => {
            writeCalls.push({ env, deviceId });
            return "/tmp/automobile-runner-DEV.xctestrun";
          },
        });
        const fakeSigning = {
          resolveSigningForDevice: async () => ({
            buildSettings: [],
            allowProvisioningUpdates: false,
            warnings: [],
          }),
        } as unknown as XcodeSigningManager;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
          fakeSigning,
        );
        const internal = manager as unknown as {
          verifyInstalledAppBundle: () => Promise<void>;
          startIproxyTunnel: () => Promise<void>;
          assertTunnelForwardsServicePort: () => void;
          startOnDevice: () => Promise<void>;
        };
        // Bypass tunnel/install verification — not under test here.
        internal.verifyInstalledAppBundle = async () => {};
        internal.startIproxyTunnel = async () => {};
        internal.assertTunnelForwardsServicePort = () => {};

        await internal.startOnDevice();

        const spawn = fakeExecutor.getSpawnedProcesses()[0];
        expect(writeCalls).toHaveLength(1);
        expect(writeCalls[0].env.CTRL_PROXY_IOS_PORT).toBe("8767");
        expect(writeCalls[0].deviceId).toBe(physicalDevice.deviceId);

        // xcodebuild points at the per-launch copy; the bare build-setting token is gone.
        expect(spawn.command).toBe("xcodebuild");
        expect(spawn.args).toContain("/tmp/automobile-runner-DEV.xctestrun");
        expect(spawn.args).not.toContain("CTRL_PROXY_IOS_PORT=8767");
        expect(spawn.options?.shell).toBe(false);
        expect(spawn.options?.detached).toBe(true);

        // Host env still carries identity vars for daemon-side process discovery.
        expect(spawn.options?.env).toMatchObject({
          CTRL_PROXY_IOS_PORT: "8767",
          AUTOMOBILE_DEVICE_ID: physicalDevice.deviceId,
        });
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("startOnDevice() ignores late exit and error events from a replaced child", async function () {
      const physicalDevice: BootedDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone",
      };
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
        {
          resolveSigningForDevice: async () => ({
            buildSettings: [],
            allowProvisioningUpdates: false,
            warnings: [],
          }),
        } as unknown as XcodeSigningManager,
      );
      const internal = manager as unknown as {
        verifyInstalledAppBundle: () => Promise<void>;
        startIproxyTunnel: () => Promise<void>;
        assertTunnelForwardsServicePort: () => void;
        startOnDevice: () => Promise<void>;
        xcTestProcessId: number | null;
        xcTestProcess: FakeChildProcess | null;
      };
      internal.verifyInstalledAppBundle = async () => {};
      internal.startIproxyTunnel = async () => {};
      internal.assertTunnelForwardsServicePort = () => {};

      await internal.startOnDevice();
      const staleChild = fakeExecutor.getSpawnedProcesses()[0].process as FakeChildProcess;
      const replacement = new FakeChildProcess();
      replacement.pid = 41002;
      internal.xcTestProcessId = replacement.pid;
      internal.xcTestProcess = replacement;

      staleChild.emit("error", new Error("late stale failure"));
      staleChild.emit("exit", 1, null);
      await Promise.resolve();

      expect(internal.xcTestProcessId).toBe(41002);
      expect(internal.xcTestProcess).toBe(replacement);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    });

    test("stop() retains runner ownership and fails when SIGKILL cannot terminate it", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );
      const process: FakeListeningProcess = {
        pid: 42001,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [process]);
      fakeTimer.enableAutoAdvance();
      const child = new FakeChildProcess();
      child.pid = process.pid;
      const internal = manager as unknown as {
        xcTestProcessId: number | null;
        xcTestProcess: FakeChildProcess | null;
      };
      internal.xcTestProcessId = process.pid;
      internal.xcTestProcess = child;

      await expect(manager.stop()).rejects.toThrow(
        "CtrlProxy process tree rooted at PID 42001 remained alive after SIGKILL",
      );

      expect(internal.xcTestProcessId).toBe(42001);
      expect(internal.xcTestProcess).toBe(child);
      expect(process.alive).toBe(true);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(manager.getServicePort());
    });

    test("start() terminates a stale owned runner on the intended port before spawning", async function () {
      const staleProcess: FakeListeningProcess = {
        pid: 2222,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
        ignoreTerm: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await manager.start();

      expect(staleProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2222")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2222")).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8765",
      });
    });

    test("start() adopts a direct runner for the current simulator while it is still starting", async function () {
      const runnerProcess: FakeListeningProcess = {
        pid: 2223,
        port: 8765,
        ppid: 2222,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        alive: true,
      };
      const parentProcess: FakeListeningProcess = {
        pid: 2222,
        port: 0,
        ppid: 1,
        command: `launchd_sim ${testDevice.deviceId}`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [runnerProcess, parentProcess]);
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port) => port !== 8765,
      });
      try {
        fakeExecutor.setCommandResponse("http://127.0.0.1:8765/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("http://127.0.0.1:8766/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
        fakeTimer.enableAutoAdvance();
        const fakeBuilder = asIosCtrlProxyBuilder({
          getXctestrunPath: async () => {
            throw new Error("should not build when an external direct runner is reused");
          },
          getRunnerBinaryPath: async () => null,
          verifyRunnerBinaryBeforeLaunch: async () => {},
          writeRunnerEnvironment: fakeWriteRunnerEnvironment,
        });
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor,
        );

        await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

        expect(runnerProcess.alive).toBe(true);
        expect(fakeExecutor.wasCommandExecuted("kill -TERM 2223")).toBe(false);
        expect(fakeExecutor.wasCommandExecuted("kill -KILL 2223")).toBe(false);
        expect(manager.getServicePort()).toBe(8765);
        expect(PortManager.getPort(testDevice.deviceId)).toBe(8765);
        expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("forceRestart() terminates a stalled runner left on the retired port instead of adopting it as external (#11205)", async function () {
      // Killing the daemon's xcodebuild leaves the in-simulator runner alive under
      // launchd_sim. A SIGSTOPped runner keeps its listener on the retired port but
      // never answers /health; it must be terminated and a fresh runner spawned.
      const stalledRunner: FakeListeningProcess = {
        pid: 2223,
        port: 8765,
        ppid: 2222,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        alive: true,
        ignoreTerm: true,
      };
      const launchdSim: FakeListeningProcess = {
        pid: 2222,
        port: 0,
        ppid: 1,
        command: `launchd_sim ${testDevice.deviceId}`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [stalledRunner, launchdSim]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", (command) =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0 && !command.includes(":8765/")
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );
      expect(manager.getServicePort()).toBe(8765);
      spyOn(manager, "stop").mockResolvedValue();

      await manager.forceRestart();

      expect(stalledRunner.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2223")).toBe(true);
      expect(launchdSim.alive).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      expect(manager.getServicePort()).not.toBe(8765);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: String(manager.getServicePort()),
      });
    });

    test("start() reclaims a stale daemon-owned xcodebuild even when pgrep finds it", async function () {
      const staleProcess: FakeListeningProcess = {
        pid: 2223,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2223\n", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await manager.start();

      expect(staleProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2223")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2223")).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8765",
      });
    });

    test("start() reclaims a stale daemon-owned xcodebuild with an orphaned shell parent", async function () {
      const staleProcess: FakeListeningProcess = {
        pid: 2225,
        port: 8765,
        ppid: 2224,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
      };
      const orphanedShellProcess: FakeListeningProcess = {
        pid: 2224,
        port: 0,
        ppid: 1,
        command: `/bin/sh -c ${staleProcess.command} 2>&1`,
        environment: staleProcess.environment,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleProcess, orphanedShellProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2225\n", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await manager.start();

      expect(staleProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2225")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 2225")).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8765",
      });
    });

    test("start() reclaims a stale listener by terminating the daemon-managed shell root (#2847)", async function () {
      const staleListener: FakeListeningProcess = {
        pid: 2227,
        port: 8765,
        ppid: 2226,
        command: `/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const daemonXcodebuild: FakeListeningProcess = {
        pid: 2226,
        port: 0,
        ppid: 2225,
        command:
          `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const daemonShell: FakeListeningProcess = {
        pid: 2225,
        port: 0,
        ppid: 1,
        command: `/bin/sh -c ${daemonXcodebuild.command} 2>&1`,
        environment: daemonXcodebuild.environment,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleListener, daemonXcodebuild, daemonShell]);
      const originalSpawn = fakeExecutor.spawn.bind(fakeExecutor);
      let portWasFreeAtSpawn = false;
      fakeExecutor.spawn = (command, args, options) => {
        portWasFreeAtSpawn = !staleListener.alive;
        return originalSpawn(command, args, options);
      };
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      // The health-first direct-runner probe sees this candidate, but its
      // daemon-managed shell root must keep it out of adoption so port cleanup
      // can reap the dead runner tree.
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("2227\n", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );
      await manager.start();

      expect(fakeExecutor.wasCommandExecuted("ps -p 2226")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -2225")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2226")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 2227")).toBe(true);
      expect(daemonShell.alive).toBe(false);
      expect(daemonXcodebuild.alive).toBe(false);
      expect(staleListener.alive).toBe(false);
      expect(portWasFreeAtSpawn).toBe(true);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("start() reallocates when the intended port is held by a foreign process", async function () {
      const foreignProcess: FakeListeningProcess = {
        pid: 3333,
        port: 8765,
        command: "adb -L tcp:localhost:8765 fork-server server --reply-fd 4",
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [foreignProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await manager.start();

      expect(foreignProcess.alive).toBe(true);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8767",
      });
    });

    test("start() reallocates instead of killing another simulator's CtrlProxy runner on the intended port", async function () {
      const otherSimulatorProcess: FakeListeningProcess = {
        pid: 3334,
        port: 8765,
        command:
          "xcodebuild test CtrlProxyUITests -destination id=OTHER-SIMULATOR CTRL_PROXY_IOS_PORT=8765",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [otherSimulatorProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("3334\n", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await manager.start();

      expect(otherSimulatorProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 3334")).toBe(false);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8767",
      });
    });

    test("start() reallocates instead of killing another simulator's direct runner on the intended port", async function () {
      const otherSimulatorProcess: FakeListeningProcess = {
        pid: 3335,
        port: 8765,
        ppid: 3334,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      const otherSimulatorParent: FakeListeningProcess = {
        pid: 3334,
        port: 0,
        ppid: 1,
        command: "launchd_sim OTHER-SIMULATOR",
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [otherSimulatorProcess, otherSimulatorParent]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await manager.start();

      expect(otherSimulatorProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 3335")).toBe(false);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8767",
      });
    });

    test("start() terminates a stale direct runner identified by environment before spawning", async function () {
      const staleProcess: FakeListeningProcess = {
        pid: 3335,
        port: 8765,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        environment: `AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
      };
      installListeningProcessFakes(fakeExecutor, [staleProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await manager.start();

      expect(staleProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 3335")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL 3335")).toBe(true);
      expect(manager.getServicePort()).toBe(8765);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8765",
      });
    });

    test("start() reallocates instead of killing another simulator's direct runner identified by environment", async function () {
      const otherSimulatorProcess: FakeListeningProcess = {
        pid: 3336,
        port: 8765,
        command:
          "/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner",
        environment: "AUTOMOBILE_DEVICE_ID=OTHER-SIMULATOR",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [otherSimulatorProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await manager.start();

      expect(otherSimulatorProcess.alive).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 3336")).toBe(false);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect(fakeExecutor.getSpawnedProcesses()[0].options?.env).toMatchObject({
        CTRL_PROXY_IOS_PORT: "8767",
      });
    });

    test("startup orphan reaping terminates orphaned CtrlProxy xcodebuild processes", async function () {
      const orphanProcess: FakeListeningProcess = {
        pid: 4444,
        port: 8765,
        ppid: 1,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [orphanProcess]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("4444\n", ""));
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
        new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
        fakeTimer,
      );

      expect(orphanProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 4444")).toBe(true);
    });

    test("startup orphan reaping terminates orphaned CtrlProxy UITest runner processes", async function () {
      const orphanProcess: FakeListeningProcess = {
        pid: 4445,
        port: 8765,
        ppid: 1,
        command: `/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner ${testDevice.deviceId}`,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [orphanProcess]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("4445\n", ""));
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
        new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
        fakeTimer,
      );

      expect(orphanProcess.alive).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 4445")).toBe(true);
    });

    test("startup orphan reaping terminates daemon-managed shell-rooted runner trees (#2847)", async function () {
      const orphanedRunner: FakeListeningProcess = {
        pid: 4448,
        port: 8765,
        ppid: 4447,
        command: `/tmp/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests-Runner`,
        environment: `AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const orphanedXcodebuild: FakeListeningProcess = {
        pid: 4447,
        port: 0,
        ppid: 4446,
        command:
          `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
      const orphanedShell: FakeListeningProcess = {
        pid: 4446,
        port: 0,
        ppid: 1,
        command: `/bin/sh -c ${orphanedXcodebuild.command} 2>&1`,
        environment: orphanedXcodebuild.environment,
        alive: true,
      };
      installListeningProcessFakes(fakeExecutor, [
        orphanedRunner,
        orphanedXcodebuild,
        orphanedShell,
      ]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("4447\n4448\n", ""));
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
        new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
        fakeTimer,
      );

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -4446")).toBe(true);
      expect(orphanedShell.alive).toBe(false);
      expect(orphanedXcodebuild.alive).toBe(false);
      expect(orphanedRunner.alive).toBe(false);
    });

    test("startup orphan reaping preserves CtrlProxy xcodebuild with a live non-orphan parent (#2847)", async function () {
      const liveParent: FakeListeningProcess = {
        pid: 4450,
        port: 0,
        ppid: 4400,
        command: "node dist/src/index.js --daemon-mode",
        alive: true,
      };
      const liveXcodebuild: FakeListeningProcess = {
        pid: 4451,
        port: 0,
        ppid: 4450,
        command:
          `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [liveParent, liveXcodebuild]);
      fakeExecutor.setCommandResponse("pgrep -f 'CtrlProxy'", createExecResult("4451\n", ""));
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
        new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
        fakeTimer,
      );

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -4451")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 4451")).toBe(false);
      expect(liveXcodebuild.alive).toBe(true);
    });

    test("startup orphan reaping caps candidate process work and logs skipped candidates", async function () {
      const candidates: FakeListeningProcess[] = Array.from(
        { length: MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES + 1 },
        (_, index) => ({
          pid: 6000 + index,
          port: 0,
          ppid: 1,
          command:
            `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy-${index}.xctestrun ` +
            `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
            `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
          alive: true,
        }),
      );
      const fakeExecutor = new FakeProcessExecutor();
      installListeningProcessFakes(fakeExecutor, candidates);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(candidates.map((candidate) => String(candidate.pid)).join("\n"), ""),
      );
      fakeTimer.enableAutoAdvance();
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
          new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
          fakeTimer,
        );

        expect(candidates.filter((candidate) => candidate.alive)).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("skipped 1 startup CtrlProxy runner candidate"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("startup orphan reaping filters unrelated xcodebuild candidates before applying its cap", async function () {
      const unrelatedXcodebuilds: FakeListeningProcess[] = Array.from(
        { length: MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES },
        (_, index) => ({
          pid: 6500 + index,
          port: 0,
          ppid: 1,
          command: `xcodebuild test-without-building -xctestrun /tmp/Unrelated-${index}.xctestrun`,
          alive: true,
        }),
      );
      const orphanedRunner: FakeListeningProcess = {
        pid: 6600,
        port: 0,
        ppid: 1,
        command: "/tmp/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner",
        alive: true,
      };
      const fakeExecutor = new FakeProcessExecutor();
      installListeningProcessFakes(fakeExecutor, [...unrelatedXcodebuilds, orphanedRunner]);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(`${orphanedRunner.pid}\n`, ""),
      );
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
        new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
        fakeTimer,
      );

      expect(orphanedRunner.alive).toBe(false);
      expect(unrelatedXcodebuilds.every((process) => process.alive)).toBe(true);
    });

    test("startup orphan reaping inspects past live CtrlProxy runners before applying its cap", async function () {
      const liveRunners: FakeListeningProcess[] = Array.from(
        { length: MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES },
        (_, index) => ({
          pid: 6700 + index,
          port: 0,
          ppid: 8000 + index,
          command: `/tmp/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner live-${index}`,
          alive: true,
        }),
      );
      const orphanedRunner: FakeListeningProcess = {
        pid: 6800,
        port: 0,
        ppid: 1,
        command: "/tmp/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner orphan",
        alive: true,
      };
      const fakeExecutor = new FakeProcessExecutor();
      installListeningProcessFakes(fakeExecutor, [...liveRunners, orphanedRunner]);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(
          [...liveRunners, orphanedRunner].map((process) => String(process.pid)).join("\n"),
          "",
        ),
      );
      fakeTimer.enableAutoAdvance();

      await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
        new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
        fakeTimer,
      );

      expect(orphanedRunner.alive).toBe(false);
      expect(liveRunners.every((process) => process.alive)).toBe(true);
    });

    test("startup orphan reaping stops at its fake-clock deadline", async function () {
      const candidates: FakeListeningProcess[] = [0, 1].map((index) => ({
        pid: 7000 + index,
        port: 0,
        ppid: 1,
        command:
          `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy-${index}.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
      }));
      const fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandHandler("ps -p", (command) => {
        const pid = Number(command.match(/ps -p\s+(\d+)/)?.[1]);
        const process = candidates.find((candidate) => candidate.pid === pid && candidate.alive);
        fakeTimer.advanceTime(STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS);
        return createExecResult(process ? `${process.ppid} ${process.command}` : "", "");
      });
      installListeningProcessFakes(fakeExecutor, candidates);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(candidates.map((candidate) => String(candidate.pid)).join("\n"), ""),
      );
      fakeTimer.enableAutoAdvance();
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
          new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
          fakeTimer,
        );

        expect(candidates.filter((candidate) => candidate.alive)).toHaveLength(2);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("startup CtrlProxy runner sweep timed out"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("startup orphan reaping does not terminate a tree when ancestry traversal exhausts its deadline", async function () {
      const shell: FakeListeningProcess = {
        pid: 7101,
        port: 0,
        ppid: 1,
        command: "/bin/sh -c xcodebuild",
        alive: true,
      };
      const xcodebuild: FakeListeningProcess = {
        pid: 7102,
        port: 0,
        ppid: shell.pid,
        command:
          `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun ` +
          `-destination platform=iOS Simulator,id=${testDevice.deviceId} ` +
          "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
        alive: true,
      };
      const runner: FakeListeningProcess = {
        pid: 7103,
        port: 0,
        ppid: xcodebuild.pid,
        command: "/tmp/CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner",
        alive: true,
      };
      const fakeExecutor = new FakeProcessExecutor();
      installListeningProcessFakes(fakeExecutor, [shell, xcodebuild, runner]);
      fakeExecutor.setCommandResponse(
        "pgrep -f 'CtrlProxy'",
        createExecResult(`${runner.pid}\n`, ""),
      );
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      let nowCallCount = 0;
      const nowSpy = spyOn(fakeTimer, "now").mockImplementation(() => {
        nowCallCount++;
        return nowCallCount >= 4 ? STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS : 0;
      });

      try {
        await IOSCtrlProxyManager.reapOrphanedRunnerProcessesOnStartup(
          new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer),
          fakeTimer,
        );

        expect(runner.alive).toBe(true);
        expect(xcodebuild.alive).toBe(true);
        expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -7101")).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("startup CtrlProxy runner sweep timed out"),
        );
      } finally {
        nowSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    test("start waits for startup orphan reaping before probing a simulator runner", async function () {
      const reaping = deferred();
      const reapSpy = spyOn(
        IOSCtrlProxyManager,
        "reapOrphanedRunnerProcessesOnStartup",
      ).mockImplementation(() => reaping.promise);
      const fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandResponse(
        "curl -s",
        createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      try {
        IOSCtrlProxyManager.startOrphanRunnerReapOnStartup();
        const start = manager.start();
        await Promise.resolve();

        expect(fakeExecutor.wasCommandExecuted("curl -s")).toBe(false);
        reaping.resolve();
        await start;
        expect(fakeExecutor.wasCommandExecuted("curl -s")).toBe(true);
      } finally {
        reapSpy.mockRestore();
      }
    });

    test("startup reaping releases simulator start after its deadline when process cleanup hangs", async function () {
      const reaping = deferred();
      const reapSpy = spyOn(
        IOSCtrlProxyManager,
        "reapOrphanedRunnerProcessesOnStartup",
      ).mockImplementation(() => reaping.promise);
      const fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandResponse(
        "curl -s",
        createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
      );
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      try {
        IOSCtrlProxyManager.startOrphanRunnerReapOnStartup(undefined, fakeTimer);
        const start = manager.start();
        await Promise.resolve();

        expect(fakeExecutor.wasCommandExecuted("curl -s")).toBe(false);
        fakeTimer.advanceTime(STARTUP_ORPHAN_RUNNER_REAP_DEADLINE_MS);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fakeExecutor.wasCommandExecuted("curl -s")).toBe(true);

        reaping.resolve();
        await fakeTimer.resolvePromise(start);
      } finally {
        reapSpy.mockRestore();
      }
    });

    test("start() reports the bound PID and command when owned port cleanup cannot free the port", async function () {
      const stuckProcess: FakeListeningProcess = {
        pid: 5555,
        port: 8765,
        command: `xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun -destination platform=iOS Simulator,id=${testDevice.deviceId} -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [stuckProcess]);
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("", ""));
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      await expect(manager.start()).rejects.toThrow(
        /port 8765 still held by PID 5555 .*xcodebuild test-without-building/,
      );
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);
    });
  });
});
