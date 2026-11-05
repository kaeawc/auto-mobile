import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../../src/daemon/client/client";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import type { UnixSocketServer } from "../../src/daemon/socketServer";
import { DeviceConditionRegistry } from "../../src/features/deviceCondition/DeviceConditionRegistry";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import type { BootedDevice } from "../../src/models";
import {
  DEVICE_CONDITION_FLAG_DISABLED_MESSAGE,
  handleDeviceConditionCall,
  registerDeviceConditionFeatureFlags,
} from "../../src/server/deviceConditionTool";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { toolText } from "../helpers/toolResponse";

/**
 * #16909: `--daemon set-feature-flag` end to end. A real `DaemonClient` (the plain CLI
 * identity, not the IDE plugin's) talks to a real `UnixSocketServer` on a private socket, and
 * the flag change is read by the in-process deviceCondition handler through the same
 * `FeatureFlagService` the daemon's MCP server registers, with no restart in between.
 */

const unexpected = (): never => {
  throw new Error("Unexpected local daemon state access");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

const idleDaemonState = {
  isInitialized: () => true,
  getSessionManager: () => ({
    hasSession: () => false,
    getSession: () => null,
    getDeviceLabels: () => undefined,
    releaseSession: async () => null,
  }),
  getDeviceSessionRegistry: () => ({ list: () => [] }),
  getDevicePool: () => ({
    refreshDevices: async () => 0,
    getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
    releaseDevice: async () => {},
  }),
};

const device: BootedDevice = {
  name: "emulator-5554",
  platform: "android",
  deviceId: "emulator-5554",
};

type CliOutput = Array<[string, unknown]>;

async function runCli(
  args: string[],
  socketPath: string,
  namespaceEnv: NodeJS.ProcessEnv,
): Promise<CliOutput> {
  const output: CliOutput = [];
  const exited = new Error("fake exit");
  const log = spyOn(console, "log").mockImplementation((text) => output.push(["stdout", text]));
  const error = spyOn(console, "error").mockImplementation((text) => output.push(["stderr", text]));
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    output.push(["exit", code]);
    throw exited;
  });
  try {
    await runDaemonCommand(
      "set-feature-flag",
      args,
      {
        clientFactory: () => new DaemonClient(socketPath),
        stateProvider: () => remoteState,
        namespaceEnv,
      },
      SafeDaemonManager,
    ).catch((caught: unknown) => {
      if (caught !== exited) {
        throw caught;
      }
    });
  } finally {
    exit.mockRestore();
    error.mockRestore();
    log.mockRestore();
  }
  return output;
}

function deviceConditionCall() {
  // No featureFlags dep: the handler reads the service registered as the MCP server does.
  return handleDeviceConditionCall(
    device,
    { deviceCondition: { rootState: "unset" }, sessionUuid: "session-16909" },
    { registry: new DeviceConditionRegistry(() => undefined) },
  );
}

describe("--daemon set-feature-flag through a real daemon socket (#16909)", () => {
  let dir: string;
  let socketPath: string;
  let featureFlags: FeatureFlagService;
  let server: UnixSocketServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "am-ff-cli-"));
    socketPath = join(dir, "daemon.sock");
    featureFlags = new FeatureFlagService(
      new FakeFeatureFlagRepository(),
      new FakeFeatureFlagApplier(),
    );
    await featureFlags.initialize();
    registerDeviceConditionFeatureFlags(featureFlags);
    server = createTestUnixSocketServer(socketPath, idleDaemonState, new FakeTimer(), featureFlags);
    await server.start();
  });

  afterEach(async () => {
    registerDeviceConditionFeatureFlags({ isEnabled: () => false });
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a CLI connection sets the flag and setDeviceState's deviceCondition gets past the gate without a restart", async () => {
    expect(featureFlags.isEnabled("device-condition")).toBe(false);
    expect(toolText(await deviceConditionCall())).toContain(DEVICE_CONDITION_FLAG_DISABLED_MESSAGE);

    const output = await runCli(["device-condition", "true", "--json"], socketPath, {
      AUTOMOBILE_DATA_DIR: join(dir, "data"),
      AUTOMOBILE_DAEMON_SOCKET_PATH: socketPath,
    });

    expect(output).toHaveLength(1);
    expect(output[0]?.[0]).toBe("stdout");
    const printed = JSON.parse(String(output[0]?.[1])) as {
      ok: boolean;
      flag: { key: string; enabled: boolean };
    };
    expect(printed.ok).toBe(true);
    expect(printed.flag).toMatchObject({ key: "device-condition", enabled: true });
    expect(featureFlags.isEnabled("device-condition")).toBe(true);
    expect(toolText(await deviceConditionCall())).not.toContain("feature flag");
  });

  test("a relocated data dir without a private daemon namespace is refused before any request", async () => {
    const output = await runCli(["device-condition", "true"], socketPath, {
      AUTOMOBILE_DATA_DIR: join(dir, "data"),
    });

    expect(output).toContainEqual(["exit", 1]);
    expect(String(output[0]?.[1])).toContain("shared_daemon_namespace");
    expect(featureFlags.isEnabled("device-condition")).toBe(false);
    expect(toolText(await deviceConditionCall())).toContain(DEVICE_CONDITION_FLAG_DISABLED_MESSAGE);
  });
});
