import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { IosAppNetworkRuleClient } from "../../src/features/network-filter/IosAppNetworkRuleClient";
import { logger } from "../../src/utils/logger";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeNetworkFilterBridge } from "../fakes/FakeNetworkFilterBridge";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";

const SIM = "12345678-1234-1234-1234-123456789ABC";
const OTHER_SIM = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
const APP = "com.example.app";
const SESSION = "ios-net-session";

const simulator = (deviceId = SIM): BootedDevice => ({
  name: "iPhone 16",
  platform: "ios",
  deviceId,
});

/**
 * iOS Simulator per-app offline through setDeviceState/getDeviceState and the
 * session lifecycle (#10264). One fake bridge stands in for the controller for
 * both the setter and the session manager's renew/reset seam.
 */
describe("setDeviceState iOS Simulator app offline (#10264)", () => {
  let bridge: FakeNetworkFilterBridge;
  let timer: FakeTimer;
  let manager: SessionManager;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  const call = async (tool: string, args: Record<string, unknown>, device = simulator()) => {
    const response = await ToolRegistry.getTool(tool)!.deviceAwareHandler!(device, args);
    return JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
  };
  const offline = (args: Record<string, unknown> = {}) =>
    call("setDeviceState", {
      sessionUuid: SESSION,
      networkCondition: { profile: "offline", appId: APP, ...args },
    });
  const restore = () =>
    call("setDeviceState", {
      sessionUuid: SESSION,
      networkCondition: { profile: "none", appId: APP },
    });
  const commands = () =>
    bridge.ruleCalls.map((entry) => [
      entry.command,
      entry.ownership.owner,
      entry.ownership.revision,
    ]);
  /**
   * Every reset after the apply carries a strictly newer revision, so a late
   * delivery of the apply is fenced. Exact reset revisions are not pinned: each
   * restore-target capture allocates one.
   */
  const expectFencedResets = (expected: string[]) => {
    expect(bridge.ruleCalls.map((entry) => entry.command)).toEqual(expected);
    expect(bridge.ruleCalls.every((entry) => entry.ownership.owner === SESSION)).toBe(true);
    const revisions = bridge.ruleCalls.map((entry) => entry.ownership.revision);
    expect(revisions[0]).toBe(1);
    expect(
      revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!),
    ).toBe(true);
  };

  beforeEach(async () => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    timer = new FakeTimer();
    timer.setCurrentTime(1_759_900_000_000);
    const client = new IosAppNetworkRuleClient(bridge);
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => {} }),
      () => ({ restore: async () => {} }),
      {
        networkCondition: () => ({ restore: async () => {} }),
        clock: () => ({ restore: async () => {} }),
        iosAppNetworkRule: {
          reset: async (rule) => {
            const result = await client.reset(rule);
            if (result.kind !== "reset") {
              throw new Error(`reset not confirmed: ${result.kind}`);
            }
          },
          renew: (rule, leaseMs) => client.renew(rule, leaseMs),
        },
      },
    );
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "test-daemon", {
        timer,
        deviceManager: new FakeDeviceManager([], []),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    DaemonState.getInstance().initialize(manager, pool);
    ToolRegistry.clearTools();
    registerUtilityTools({ networkFilterBridge: bridge });
    await manager.createSession(SESSION, SIM, "ios");
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    PlatformDeviceManagerFactory.reset();
    warn.mockRestore();
  });

  test("applies, reads back from the provider, and renews the lease on the session timer", async () => {
    const applied = await offline();

    expect(applied.success).toBe(true);
    expect(applied.networkCondition).toMatchObject({
      scope: "app",
      appId: APP,
      appliedProfile: "offline",
      acknowledged: true,
      rule: { revision: 1 },
    });
    const slot = manager.getNetworkCondition(SESSION)?.iosAppRule;
    expect(slot).toMatchObject({ udid: SIM, bundleId: APP, installedRevision: 1, lastRevision: 1 });
    expect(slot?.ownerGeneration).toBe(1_759_900_000_000);

    const read = await call("getDeviceState", { include: ["networkCondition"] });
    expect(read.networkCondition).toMatchObject({
      supported: true,
      capability: "partial",
      scope: "app",
      rules: [{ appId: APP, revision: 1, owner: SESSION }],
    });

    await timer.advanceTimeAsync(10_000);
    expect(commands()).toEqual([
      ["apply", SESSION, 1],
      ["renew", SESSION, 1],
      ["renew", SESSION, 1],
    ]);
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test("release removes the rule with a newer revision and stops renewing", async () => {
    await offline();

    await manager.releaseSession(SESSION);
    await timer.advanceTimeAsync(15_000);

    expectFencedResets(["apply", "reset"]);
    expect(bridge.activeRules()).toEqual([]);
  });

  test("an explicit reset removes the rule, drops the slot, and release sends nothing more", async () => {
    await offline();

    const reset = await restore();
    await manager.releaseSession(SESSION);
    await timer.advanceTimeAsync(15_000);

    expect(reset.success).toBe(true);
    expect(reset.networkCondition).toMatchObject({ appliedProfile: "none", acknowledged: true });
    expect(commands()).toEqual([
      ["apply", SESSION, 1],
      ["reset", SESSION, 2],
    ]);
  });

  test("a failed apply is rolled back; the slot stays so release still resets", async () => {
    bridge.ruleScripts.push("dropped");

    const applied = await offline();
    expect(applied.success).toBe(false);
    expect(manager.activeIosAppNetworkLease(SESSION)).toBeUndefined();
    await manager.releaseSession(SESSION);

    expectFencedResets(["apply", "reset", "reset"]);
  });

  test("an uncertain apply found installed by read-back starts renewing", async () => {
    bridge.ruleScripts.push("lost");

    const applied = await offline();
    await timer.advanceTimeAsync(5_000);

    expect(applied.success).toBe(true);
    expect(applied.networkCondition.warning).toContain("read-back found the rule installed");
    expect(commands()).toEqual([
      ["apply", SESSION, 1],
      ["renew", SESSION, 1],
    ]);
  });

  test("a TTL elapses into a reset that also stops the lease", async () => {
    await offline({ expiresInSeconds: 7 });

    await timer.advanceTimeAsync(20_000);

    expect(commands()).toEqual([
      ["apply", SESSION, 1],
      ["renew", SESSION, 1],
      ["reset", SESSION, 2],
    ]);
    expect(manager.getNetworkCondition(SESSION)).toBeUndefined();
    expect(manager.activeIosAppNetworkLease(SESSION)).toBeUndefined();
  });

  test("rebind removes the old simulator's rule", async () => {
    await offline();

    await manager.rebindSession(SESSION, OTHER_SIM, "ios");
    await timer.advanceTimeAsync(15_000);

    expectFencedResets(["apply", "reset"]);
    expect(bridge.activeRules()).toEqual([]);
  });

  test("a lease the provider no longer holds stops renewing", async () => {
    await offline();
    bridge.expireAll();

    await timer.advanceTimeAsync(15_000);

    expect(commands()).toEqual([
      ["apply", SESSION, 1],
      ["renew", SESSION, 1],
    ]);
    expect(manager.activeIosAppNetworkLease(SESSION)).toBeUndefined();
  });

  test("one app per session: another app must be reset first", async () => {
    await offline();

    const second = await call("setDeviceState", {
      sessionUuid: SESSION,
      networkCondition: { profile: "offline", appId: "com.example.other" },
    }).catch((error: unknown) => ({ thrown: String(error) }));

    expect(JSON.stringify(second)).toContain("already holds an offline rule for com.example.app");
    expect(commands()).toEqual([["apply", SESSION, 1]]);
  });

  test("outside a session an iOS app condition is refused and nothing is sent", async () => {
    const result = await call("setDeviceState", {
      networkCondition: { profile: "offline", appId: APP },
    });

    expect(result.success).toBe(false);
    expect(result.networkCondition.error).toContain("needs a daemon session");
    expect(bridge.ruleCalls).toEqual([]);
  });
});
