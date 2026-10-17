import { afterEach, beforeEach } from "bun:test";
import { DefaultIosTunnelClient } from "../../src/ctrlProxy/ios/IosTunnelClient";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";
import { createStartableBuilder } from "./iosCtrlProxyBuilderFake";

export function tunnel(manager: IOSCtrlProxyManager): DefaultIosTunnelClient {
  const client = manager["tunnelClient"];
  if (!(client instanceof DefaultIosTunnelClient)) {
    throw new Error("Expected default tunnel");
  }
  return client;
}

export interface FakeListeningProcess {
  pid: number;
  port: number;
  command: string;
  alive: boolean;
  ppid?: number;
  pgid?: number;
  environment?: string;
  ignoreTerm?: boolean;
  ignoreKill?: boolean;
}

export function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * A minimal format-version-1 xctestrun with a single UI-test bundle, used by the
 * boundary test to model what the in-simulator runner actually reads.
 */
export const BOUNDARY_XCTESTRUN = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  "<dict>",
  "\t<key>CtrlProxyUITests</key>",
  "\t<dict>",
  "\t\t<key>EnvironmentVariables</key>",
  "\t\t<dict>",
  "\t\t\t<key>TERM</key>",
  "\t\t\t<string>dumb</string>",
  "\t\t</dict>",
  "\t\t<key>IsUITestBundle</key>",
  "\t\t<true/>",
  "\t</dict>",
  "</dict>",
  "</plist>",
].join("\n");

export function installListeningProcessFakes(
  fakeExecutor: FakeProcessExecutor,
  processes: FakeListeningProcess[],
): void {
  const markProcessDead = (pid: number, signal: "TERM" | "KILL") => {
    const process = processes.find((candidate) => candidate.pid === pid);
    if (process && !(signal === "TERM" ? process.ignoreTerm : process.ignoreKill)) {
      process.alive = false;
    }
  };

  fakeExecutor.setCommandHandler("lsof -nP -iTCP:", (command) => {
    const port = Number(command.match(/-iTCP:(\d+)/)?.[1]);
    const stdout = processes
      .filter((process) => process.alive && process.port === port)
      .map((process) => `p${process.pid}`)
      .join("\n");
    return createExecResult(stdout, "");
  });
  fakeExecutor.setCommandHandler("ps -p", (command) => {
    const pid = Number(command.match(/ps -p\s+(\d+)/)?.[1]);
    const process = processes.find((candidate) => candidate.pid === pid && candidate.alive);
    return createExecResult(process ? `${process.ppid ?? 1} ${process.command}` : "", "");
  });
  fakeExecutor.setCommandHandler("ps eww -p", (command) => {
    const pid = Number(command.match(/ps eww -p\s+(\d+)/)?.[1]);
    const process = processes.find((candidate) => candidate.pid === pid && candidate.alive);
    return createExecResult(
      process ? `${process.command} ${process.environment ?? ""}`.trim() : "",
      "",
    );
  });
  fakeExecutor.setCommandHandler("ps -axo pid=,ppid=", () =>
    createExecResult(
      processes
        .filter((process) => process.alive)
        .map((process) => `${process.pid} ${process.ppid ?? 1}`)
        .join("\n"),
      "",
    ),
  );
  fakeExecutor.setCommandHandler("kill -TERM", (command) => {
    const groupPid = Number(command.match(/kill -TERM -- -(\d+)/)?.[1]);
    if (!Number.isNaN(groupPid)) {
      for (const process of processes.filter(
        (candidate) => candidate.alive && (candidate.pgid ?? candidate.pid) === groupPid,
      )) {
        markProcessDead(process.pid, "TERM");
      }
      return createExecResult("", "");
    }
    const pid = Number(command.match(/kill -TERM\s+(\d+)/)?.[1]);
    markProcessDead(pid, "TERM");
    return createExecResult("", "");
  });
  fakeExecutor.setCommandHandler("kill -KILL", (command) => {
    const groupPid = Number(command.match(/kill -KILL -- -(\d+)/)?.[1]);
    if (!Number.isNaN(groupPid)) {
      for (const process of processes.filter(
        (candidate) => candidate.alive && (candidate.pgid ?? candidate.pid) === groupPid,
      )) {
        markProcessDead(process.pid, "KILL");
      }
      return createExecResult("", "");
    }
    const pid = Number(command.match(/kill -KILL\s+(\d+)/)?.[1]);
    markProcessDead(pid, "KILL");
    return createExecResult("", "");
  });
  fakeExecutor.setCommandHandler("kill -0", (command) => {
    const pid = Number(command.match(/kill -0\s+(\d+)/)?.[1]);
    const process = processes.find((candidate) => candidate.pid === pid && candidate.alive);
    if (!process) {
      throw new Error(`process ${pid} is not running`);
    }
    return createExecResult("", "");
  });
}

export async function flushUntil(condition: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 100 && !condition(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!condition()) {
    throw new Error(`Timed out waiting for ${description}`);
  }
}

export function createFakeBuilder(xctestrunPath = "/tmp/CtrlProxy.xctestrun") {
  return createStartableBuilder(xctestrunPath, {
    needsRebuild: async () => false,
    build: async () => ({ success: true, message: "built" }),
    getExpectedAppHash: () => null,
  });
}

export interface IosManagerSuiteContext {
  testDevice: BootedDevice;
  fakeTimer: FakeTimer;
}

/**
 * Registers the beforeEach/afterEach pair shared by every IOSCtrlProxyManager
 * suite and hands each test's fresh device and FakeTimer to `assign`. Call it
 * inside the suite's `describe`.
 */
export function installIosManagerSuiteHooks(assign: (ctx: IosManagerSuiteContext) => void): void {
  let prevHealthMaxAttempts: string | undefined;
  let fakeTimer: FakeTimer;

  beforeEach(function () {
    fakeTimer = new FakeTimer();

    // Create test device (iOS simulator format - UUID)
    const testDevice: BootedDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };
    assign({ testDevice, fakeTimer });

    // Cap the health-poll budget suite-wide. The timeout-path tests
    // (`enableAutoAdvance()` + `start()` rejects "failed to start within timeout")
    // run the FULL health-poll loop, and each iteration's `timer.sleep(500)`
    // resolves via a real `setImmediate` under auto-advance — so the loop costs
    // one real event-loop tick per attempt. At the default 60 attempts that is 60
    // real ticks whose wall-clock scales with event-loop load, which intermittently
    // blew past bun's 5000ms per-test timeout in the full suite (a real macOS-CI
    // flake, e.g. "ignores xcodebuild CtrlProxy processes for other simulators").
    // A tiny budget proves the same timeout/spawn behavior deterministically and
    // fast. Tests that need a specific budget still override this locally
    // (`withHealthBudget` / the resolver parsing test) and restore to this value.
    prevHealthMaxAttempts = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = "3";

    // Reset singleton instances
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
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
}

export function createManagerWithFakeHealthClient(
  testDevice: BootedDevice,
  fakeTimer: FakeTimer,
): IOSCtrlProxyManager {
  const executor = new FakeProcessExecutor();
  executor.setCommandResponse("curl -s", createExecResult("", ""));
  return IOSCtrlProxyManager.createForTestingWithDeps(testDevice, fakeTimer, undefined, executor);
}
