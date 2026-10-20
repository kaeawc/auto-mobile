import { FakeXcodeSigningManager } from "../fakes/FakeXcodeSigningManager";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { IosCtrlProxyBuilderSurface } from "../../src/ctrlProxy/IosCtrlProxyBuilderSurface";
import { fakeIosCtrlProxyBuilder } from "../helpers/iosCtrlProxyBuilderFake";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeIosTunnelClient } from "../fakes/FakeIosTunnelClient";
import type { IosTunnelClient, IosTunnelStart } from "../../src/ctrlProxy/ios/IosTunnelClient";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";
import type { Xcodebuild } from "../../src/utils/ios-cmdline-tools/XcodebuildClient";
import { createManagerWithOwnSteps } from "../helpers/iosCtrlProxyManagerHarness";
import type { XcodeSigningManager } from "../../src/utils/ios-cmdline-tools/XcodeSigning";

/**
 * Physical-device runner lifecycle: the iproxy tunnel and the single xcodebuild
 * runner the manager owns (#10232, #10234). The fake "world" models only what the
 * bugs depend on: a runner answers /health only through a live tunnel that forwards
 * the same host port the runner was told to listen on.
 */

const DEVICE: BootedDevice = {
  deviceId: "00008030001E28C11E",
  platform: "ios",
  name: "iPhone",
};

interface WorldProcess {
  pid: number;
  kind: "iproxy" | "xcodebuild";
  command: string;
  /** Host port an iproxy forwards, or the runner's CTRL_PROXY_IOS_PORT. */
  port: number;
  alive: boolean;
  child: FakeChildProcess;
}

class DeviceWorld {
  public readonly processes: WorldProcess[] = [];
  public readonly events: string[] = [];
  public readonly executor: FakeProcessExecutor;
  public readonly runnerPorts: number[] = [];
  /** Ports held by a foreign process, i.e. a genuine collision. */
  public readonly foreignPorts = new Set<number>();
  public runnersAnswerHealth = true;

  public constructor(private readonly timer: FakeTimer) {
    const world = this;
    this.executor = new (class extends FakeProcessExecutor {
      override spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess {
        const child = world.register("iproxy", `${command} ${args.join(" ")}`, Number(args[0]));
        this.setNextSpawnProcess(child);
        return super.spawn(command, args, options);
      }
    })();
    this.installCommandHandlers();
  }

  public listeningPorts(): Set<number> {
    return new Set([
      ...this.foreignPorts,
      ...this.alive("iproxy").map((candidate) => candidate.port),
    ]);
  }

  public alive(kind: WorldProcess["kind"]): WorldProcess[] {
    return this.processes.filter((candidate) => candidate.kind === kind && candidate.alive);
  }

  public all(kind: WorldProcess["kind"]): WorldProcess[] {
    return this.processes.filter((candidate) => candidate.kind === kind);
  }

  /** The runner's xcodebuild exits on its own (CTRL_PROXY_IOS_TIMEOUT, crash, locked device). */
  public exitOnItsOwn(process: WorldProcess): void {
    process.alive = false;
    process.child.exitCode = 1;
    process.child.emit("exit", 1, null);
  }

  /**
   * The tunnel is gone when the next start runs (device unplugged, supervisor restart
   * failing, or the call landing inside its restart backoff). No exit event is
   * delivered, so the iproxy supervisor does not race the start with its own restart.
   */
  public loseTunnel(tunnel: WorldProcess): void {
    tunnel.alive = false;
  }

  public createXcodebuild(): Xcodebuild {
    return {
      executeCommand: async () => createExecResult("", ""),
      isAvailable: async () => true,
      startStreaming: async (args, options) => {
        const runnerPort = Number(options?.env?.CTRL_PROXY_IOS_PORT);
        this.runnerPorts.push(runnerPort);
        const child = this.register("xcodebuild", `xcodebuild ${args.join(" ")}`, runnerPort);
        this.events.push(`spawn:${child.pid}`);
        return child;
      },
    };
  }

  private register(kind: WorldProcess["kind"], command: string, port: number): FakeChildProcess {
    const child = new FakeChildProcess(this.timer);
    const entry: WorldProcess = { pid: child.pid!, kind, command, port, alive: true, child };
    this.processes.push(entry);
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      entry.alive = false;
      return kill(signal);
    };
    return child;
  }

  private terminate(pid: number): void {
    const target = this.processes.find((candidate) => candidate.pid === pid);
    if (target?.alive) {
      target.alive = false;
      this.events.push(`terminate:${pid}`);
    }
  }

  private installCommandHandlers(): void {
    this.executor.setCommandResponse("idevice_id -l", createExecResult(`${DEVICE.deviceId}\n`, ""));
    this.executor.setCommandHandler("curl -s", (command) => {
      const port = Number(command.match(/:(\d+)\/health/)?.[1]);
      const tunnelled = this.alive("iproxy").some((candidate) => candidate.port === port);
      const runner = this.alive("xcodebuild").find((candidate) => candidate.port === port);
      const body =
        this.runnersAnswerHealth && tunnelled && runner
          ? JSON.stringify({ status: "ok", deviceId: DEVICE.deviceId })
          : "";
      return createExecResult(body, "");
    });
    this.executor.setCommandHandler("kill -0", (command) => {
      const pid = Number(command.match(/kill -0\s+(\d+)/)?.[1]);
      if (!this.processes.some((candidate) => candidate.pid === pid && candidate.alive)) {
        throw new Error(`process ${pid} is not running`);
      }
      return createExecResult("", "");
    });
    for (const signal of ["TERM", "KILL"]) {
      this.executor.setCommandHandler(`kill -${signal}`, (command) => {
        const group = command.match(/kill -\w+ -- -(\d+)/)?.[1];
        this.terminate(Number(group ?? command.match(/kill -\w+\s+(\d+)/)?.[1]));
        return createExecResult("", "");
      });
    }
    this.executor.setCommandHandler("ps eww -p", (command) => {
      const entry = this.find(command, /ps eww -p\s+(\d+)/);
      return createExecResult(
        entry ? `${entry.command} AUTOMOBILE_DEVICE_ID=${DEVICE.deviceId}` : "",
        "",
      );
    });
    this.executor.setCommandHandler("ps -p", (command) => {
      const entry = this.find(command, /ps -p\s+(\d+)/);
      return createExecResult(entry ? `1 ${entry.command}` : "", "");
    });
    this.executor.setCommandHandler("ps -axo pid=,ppid=", () =>
      createExecResult(
        this.processes
          .filter((candidate) => candidate.alive)
          .map((candidate) => `${candidate.pid} 1`)
          .join("\n"),
        "",
      ),
    );
  }

  private find(command: string, pattern: RegExp): WorldProcess | undefined {
    const pid = Number(command.match(pattern)?.[1]);
    return this.processes.find((candidate) => candidate.pid === pid && candidate.alive);
  }
}

function createBuilder(runnerEnvPorts: number[]): IosCtrlProxyBuilderSurface {
  return fakeIosCtrlProxyBuilder({
    getXctestrunPath: async () => "/tmp/CtrlProxy.xctestrun",
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: async (
      _path: string,
      env: Record<string, string>,
      deviceId: string,
    ) => {
      runnerEnvPorts.push(Number(env.CTRL_PROXY_IOS_PORT));
      return `/tmp/automobile-runner-${deviceId}.xctestrun`;
    },
    needsRebuild: async () => false,
    build: async () => ({ success: true, message: "built" }),
    getExpectedAppHash: () => "",
  });
}

const defaultSigning = new FakeXcodeSigningManager();

/** Drain promise continuations only, so the auto-advancing fake timer does not move. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await Promise.resolve();
  }
}

/** Let the auto-advancing fake timer run, firing supervisor monitor ticks. */
async function letTimersRun(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("IOSCtrlProxyManager physical-device runner lifecycle", function () {
  let fakeTimer: FakeTimer;
  let world: DeviceWorld;
  let runnerEnvPorts: number[];
  let prevHealthMaxAttempts: string | undefined;

  function createManagerWithSteps(
    signing: XcodeSigningManager = defaultSigning,
    tunnelClient?: IosTunnelClient,
  ): ReturnType<typeof createManagerWithOwnSteps> {
    const created = createManagerWithOwnSteps({
      device: DEVICE,
      timer: fakeTimer,
      builder: createBuilder(runnerEnvPorts),
      processExecutor: world.executor,
      signingManager: signing,
      xcodebuild: world.createXcodebuild(),
      tunnelClient,
    });
    // A runner exit would otherwise schedule the supervisor's own restart; each test
    // drives the second start explicitly instead.
    created.manager.setAutoRestart(false);
    return created;
  }

  function createManager(
    signing: XcodeSigningManager = defaultSigning,
    tunnelClient?: IosTunnelClient,
  ): IOSCtrlProxyManager {
    return createManagerWithSteps(signing, tunnelClient).manager;
  }

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    world = new DeviceWorld(fakeTimer);
    runnerEnvPorts = [];
    prevHealthMaxAttempts = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = "3";
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({
      isPortAvailable: (port) => !world.listeningPorts().has(port),
    });
  });

  afterEach(function () {
    fakeTimer.reset();
    if (prevHealthMaxAttempts === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = prevHealthMaxAttempts;
    }
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  describe("tunnel and runner agree on the host port (#10232)", function () {
    test("a restart after the runner exits keeps the port held by its own live tunnel", async function () {
      const manager = createManager();
      await manager.start();
      const firstPort = manager.getServicePort();
      expect(world.executor.getSpawnedProcesses()[0].args).toEqual([
        String(firstPort),
        String(firstPort),
        DEVICE.deviceId,
      ]);
      expect(world.alive("iproxy").map((tunnel) => tunnel.port)).toEqual([firstPort]);

      // The xcodebuild child exits while the tunnel stays up (runner timeout/crash).
      world.exitOnItsOwn(world.alive("xcodebuild")[0]);
      await flushMicrotasks();
      await manager.start();

      expect(manager.getServicePort()).toBe(firstPort);
      expect(world.all("iproxy")).toHaveLength(1);
      expect(world.all("xcodebuild")).toHaveLength(2);
      expect(runnerEnvPorts).toEqual([firstPort, firstPort]);
      expect(world.runnerPorts).toEqual([firstPort, firstPort]);
    });

    test("a port taken by another process moves the tunnel with the runner", async function () {
      const manager = createManager();
      await manager.start();
      const firstPort = manager.getServicePort();

      // The tunnel is gone and a foreign process takes its port before the restart.
      world.loseTunnel(world.alive("iproxy")[0]);
      world.exitOnItsOwn(world.alive("xcodebuild")[0]);
      world.foreignPorts.add(firstPort);
      await flushMicrotasks();
      await manager.start();

      const secondPort = manager.getServicePort();
      expect(secondPort).not.toBe(firstPort);
      const liveTunnels = world.alive("iproxy");
      expect(liveTunnels.map((tunnel) => tunnel.port)).toEqual([secondPort]);
      expect(runnerEnvPorts).toEqual([firstPort, secondPort]);
      expect(world.alive("xcodebuild").map((runner) => runner.port)).toEqual([secondPort]);
    });

    test("a live tunnel on a stale port is stopped by its recorded handle and re-pointed", async function () {
      const manager = createManager();
      await manager.start();
      const firstPort = manager.getServicePort();
      const staleTunnel = world.alive("iproxy")[0];

      // The device's port reservation moves for another reason (a competing allocation),
      // so the next launch must pick a new service port while the old tunnel is still up.
      PortManager.release(DEVICE.deviceId);
      PortManager.reserve(DEVICE.deviceId, firstPort + 100);
      world.exitOnItsOwn(world.alive("xcodebuild")[0]);
      await flushMicrotasks();
      await manager.start();

      const movedPort = manager.getServicePort();
      expect(movedPort).not.toBe(firstPort);
      expect(staleTunnel.alive).toBe(false);
      expect(world.alive("iproxy").map((tunnel) => tunnel.port)).toEqual([movedPort]);
      expect(world.alive("xcodebuild").map((runner) => runner.port)).toEqual([movedPort]);
    });

    test("fails fast, without launching a runner, when the tunnel and service port disagree", async function () {
      // The tunnel ends up forwarding a different host port than the runner is told to use.
      class MisforwardingTunnel extends FakeIosTunnelClient {
        override async start(options: IosTunnelStart): Promise<void> {
          await super.start({ ...options, localPort: options.localPort + 1 });
        }
      }
      const manager = createManager(defaultSigning, new MisforwardingTunnel());

      await expect(manager.start()).rejects.toThrow(/iproxy tunnel forwards localhost:\d+ but/);

      expect(world.all("xcodebuild")).toHaveLength(0);
      await manager.stop();
      expect(world.alive("iproxy")).toHaveLength(0);
    });
  });

  describe("a single runner per device (#10234)", function () {
    test("a healthy runner whose tunnel is down is resumed, not duplicated", async function () {
      const manager = createManager();
      await manager.start();
      const runner = world.alive("xcodebuild")[0];

      world.loseTunnel(world.alive("iproxy")[0]);
      await flushMicrotasks();
      await manager.start();

      expect(world.all("xcodebuild")).toHaveLength(1);
      expect(runner.alive).toBe(true);
      expect(world.all("iproxy")).toHaveLength(2);
      expect(world.alive("iproxy").map((tunnel) => tunnel.port)).toEqual([runner.port]);
    });

    test("a runner that is alive but unhealthy is awaited, then terminated before the single replacement", async function () {
      const manager = createManager();
      world.runnersAnswerHealth = false;
      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");
      const first = world.alive("xcodebuild")[0];

      // A retry while the first launch is still coming up must not spawn a second one.
      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");
      expect(world.all("xcodebuild")).toHaveLength(1);
      // It gave up on the hung runner by terminating it, so nothing is left behind.
      expect(first.alive).toBe(false);

      world.runnersAnswerHealth = true;
      await manager.start();

      const runners = world.all("xcodebuild");
      expect(runners).toHaveLength(2);
      expect(world.events).toEqual([
        `spawn:${runners[0].pid}`,
        `terminate:${runners[0].pid}`,
        `spawn:${runners[1].pid}`,
      ]);
      expect(world.alive("xcodebuild")).toEqual([runners[1]]);
    });

    test("the supervisor reporting an unhealthy but live runner does not hide it from the next start", async function () {
      const manager = createManager();
      await manager.start();
      world.runnersAnswerHealth = false;

      // The 30 s liveness monitor finds the runner alive but not answering.
      await letTimersRun();
      await expect(manager.start()).rejects.toThrow("CtrlProxy failed to start within timeout");

      expect(world.all("xcodebuild")).toHaveLength(1);
    });

    test("stop() after two launches leaves no runner or tunnel behind", async function () {
      const { manager, steps } = createManagerWithSteps();
      const launch = steps.startOnDevice;
      await launch();
      const first = world.alive("xcodebuild")[0];
      await launch();

      // The second launch terminated the first before spawning, so exactly one is alive.
      expect(first.alive).toBe(false);
      expect(world.alive("xcodebuild")).toHaveLength(1);
      expect(world.events.indexOf(`terminate:${first.pid}`)).toBeLessThan(
        world.events.indexOf(`spawn:${world.all("xcodebuild")[1].pid}`),
      );

      await manager.stop();

      expect(world.alive("xcodebuild")).toHaveLength(0);
      expect(world.alive("iproxy")).toHaveLength(0);
    });
  });
});
