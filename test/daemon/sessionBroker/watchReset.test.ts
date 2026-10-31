import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { parseSessionBrokerHostConfig } from "../../../src/daemon/sessionBroker/hostConfig";
import { ResetFailureError } from "../../../src/daemon/sessionBroker/ResetFailureError";
import {
  IdlePoolExpiry,
  type IdlePoolTtlMs,
} from "../../../src/daemon/sessionBroker/idlePoolExpiry";
import type { BrokerResourceRecord } from "../../../src/daemon/sessionBroker/store";
import {
  WATCH_KEEP_BOOTED_UNSUPPORTED,
  WATCH_MINIMAL_UNSUPPORTED,
  WatchSimulatorReset,
  type WatchResetPolicy,
} from "../../../src/daemon/sessionBroker/watchReset";
import { watchResetPolicy } from "../../../src/daemon/sessionBroker/watchResetNative";
import { WatchSimulatorInventory } from "../../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import { WatchSimulatorLifecycle } from "../../../src/utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeWatchLifecycleSimctl,
  WATCH_DEVICE_TYPE,
  WATCH_RUNTIME_ID,
  watchDevice,
} from "../../fakes/FakeWatchSimctl";
import { androidDefaults, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";

const UDID = "6B1F3C2E-0000-4000-8000-00000000A7C1";
const WATCH: BootedDevice = { platform: "watchos", deviceId: UDID, name: "ambroker-watch-1" };
const PROFILE = {
  platform: "watchos",
  metadataState: "current",
  runtime: WATCH_RUNTIME_ID,
  deviceType: WATCH_DEVICE_TYPE.identifier,
} as const;

function rig(policy: WatchResetPolicy, state = "Booted") {
  const simctl = new FakeWatchLifecycleSimctl([watchDevice({ udid: UDID, state })]);
  const gates: string[] = [];
  const lifecycle = new WatchSimulatorLifecycle(simctl, new WatchSimulatorInventory(simctl), {
    run: async (request, boot) => {
      gates.push(`simulator-boot-gate:${request.udid}`);
      return boot(request.timeoutMs);
    },
  });
  const stopped: string[] = [];
  const reset = new WatchSimulatorReset({
    policy,
    timer: new FakeTimer(),
    simctl,
    lifecycle,
    stopDevice: async (device) => {
      stopped.push(device.deviceId);
      await simctl.killSimulator(device);
    },
  });
  let owned = true;
  const assertOwned = async () => {
    if (!owned) {
      throw new Error("lost ownership");
    }
  };
  return {
    simctl,
    gates,
    stopped,
    reset: (device: BootedDevice = WATCH) => reset.resetWithTiming(device, PROFILE, assertOwned),
    loseOwnership: () => {
      owned = false;
    },
  };
}

describe("watch release reset follows the iOS reuse mode", () => {
  test("erase: stops, erases while shut down, boots through the simulator gate and confirms Booted", async () => {
    const r = rig({ mode: "erase" });

    const outcome = await r.reset();

    expect(outcome).toMatchObject({ outcome: "clean", mode: "erase" });
    expect(Object.keys(outcome.phases)).toEqual(["stop", "erase", "boot"]);
    expect(r.stopped).toEqual([UDID]);
    expect(r.simctl.commands).toEqual([
      `shutdown ${UDID}`,
      `erase ${UDID}`,
      `boot ${UDID} ${DEFAULT_DEVICE_READY_TIMEOUT_MS}`,
    ]);
    expect(r.gates).toEqual([`simulator-boot-gate:${UDID}`]);
    expect(r.simctl.stateOf(UDID)).toBe("Booted");
  });

  test("erase redriven after a refused boot finds the watch shut down and erases it again", async () => {
    const r = rig({ mode: "erase" }, "Shutdown");

    expect(await r.reset()).toMatchObject({ outcome: "clean", mode: "erase" });
    expect(r.stopped).toEqual([]);
    expect(r.simctl.commands).toEqual([
      `erase ${UDID}`,
      `boot ${UDID} ${DEFAULT_DEVICE_READY_TIMEOUT_MS}`,
    ]);
  });

  test("erase refuses a watch whose runtime or device type differs from its profile", async () => {
    const r = rig({ mode: "erase" });
    r.simctl.listing.devices[WATCH_RUNTIME_ID] = [
      watchDevice({
        udid: UDID,
        state: "Booted",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm",
      }),
    ];

    const error = await r.reset().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResetFailureError);
    expect((error as ResetFailureError).reset).toMatchObject({ outcome: "pending", mode: "erase" });
    expect(r.simctl.commands).toEqual([]);
  });

  test("a failed boot after the erase is a typed pending reset failure", async () => {
    const r = rig({ mode: "erase" });
    r.simctl.bootError = new Error("boot timed out");

    const error = await r.reset().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResetFailureError);
    expect((error as ResetFailureError).reset).toMatchObject({
      outcome: "pending",
      mode: "erase",
      fallbackReason: "boot timed out",
    });
    expect(r.simctl.stateOf(UDID)).toBe("Shutdown");
  });

  test("lost ownership stops the erase before any simctl mutation", async () => {
    const r = rig({ mode: "erase" });
    r.loseOwnership();

    await expect(r.reset()).rejects.toThrow("lost ownership");
    expect(r.simctl.commands).toEqual([]);
  });

  test("keep-booted with the erase fallback skips the journal cleaning by name and erases", async () => {
    const r = rig({ mode: "keep-booted", fallback: "erase" });

    expect(await r.reset()).toMatchObject({
      outcome: "fallback:erase",
      mode: "keep-booted",
      fallbackReason: WATCH_KEEP_BOOTED_UNSUPPORTED,
    });
    expect(r.simctl.commands).toEqual([
      `shutdown ${UDID}`,
      `erase ${UDID}`,
      `boot ${UDID} ${DEFAULT_DEVICE_READY_TIMEOUT_MS}`,
    ]);
  });

  test("keep-booted with the destroy fallback returns pending without touching the watch", async () => {
    const r = rig({ mode: "keep-booted", fallback: "destroy" });

    expect(await r.reset()).toEqual({
      outcome: "pending",
      mode: "keep-booted",
      phases: {},
      fallbackReason: WATCH_KEEP_BOOTED_UNSUPPORTED,
    });
    expect(r.simctl.commands).toEqual([]);
  });

  test("minimal never erases: it returns pending, so the watch is destroyed", async () => {
    const r = rig({ mode: "minimal" });

    expect(await r.reset()).toEqual({
      outcome: "pending",
      mode: "minimal",
      phases: {},
      fallbackReason: WATCH_MINIMAL_UNSUPPORTED,
    });
    expect(r.simctl.commands).toEqual([]);
  });

  test("a non-watch target is refused before anything runs", async () => {
    const r = rig({ mode: "erase" });

    await expect(r.reset({ ...WATCH, platform: "ios" })).rejects.toThrow(
      "exact Apple Watch simulator UDID",
    );
    expect(r.simctl.commands).toEqual([]);
  });
});

describe("watchResetPolicy mirrors each iOS reuse mode", () => {
  function host(reuse: unknown) {
    return parseSessionBrokerHostConfig({
      contractVersion: 1,
      limits: {},
      defaults: { ios: iosDefaults() },
      ...(reuse === undefined ? {} : { reuse: { ios: reuse } }),
    });
  }

  test.each<[unknown, WatchResetPolicy | undefined]>([
    [undefined, undefined],
    [{ mode: "off" }, undefined],
    [{ mode: "erase" }, { mode: "erase" }],
    [{ mode: "keep-booted" }, { mode: "keep-booted", fallback: "erase" }],
    [
      { mode: "keep-booted", fallback: "destroy" },
      { mode: "keep-booted", fallback: "destroy" },
    ],
    [{ mode: "minimal" }, { mode: "minimal" }],
  ])("iOS reuse %j gives the watch %j", (reuse, expected) => {
    expect(watchResetPolicy(host(reuse))).toEqual(expected);
  });

  test("a host without an iOS policy has no watch reset: released watches are destroyed", () => {
    expect(
      watchResetPolicy(
        parseSessionBrokerHostConfig({
          contractVersion: 1,
          limits: {},
          defaults: { android: androidDefaults() },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("an idle pooled watch follows the iOS idle TTL", () => {
  const watchResource: BrokerResourceRecord = {
    resourceId: "watch-resource",
    allocationIndex: 1,
    scopeKey: "scope",
    profile: { platform: "watchos", profile: PROFILE },
    state: "idle",
    requestId: null,
    revision: 3,
    idleOrder: 1,
  };

  async function expiredAfterTtl(ttl: IdlePoolTtlMs): Promise<string[]> {
    const expired: string[] = [];
    let now = 0;
    const expiry = new IdlePoolExpiry(
      ttl,
      { listLiveResources: async () => [watchResource] },
      {
        expireIdle: async (tickets) => {
          expired.push(...tickets.map((ticket) => ticket.resourceId));
          return { resources: [] };
        },
      },
      () => now,
    );
    await expiry.sweep();
    now = 10;
    await expiry.sweep();
    return expired;
  }

  test("the iOS TTL expires an idle watch", async () => {
    expect(await expiredAfterTtl({ ios: 10 })).toEqual(["watch-resource"]);
  });

  test("an Android-only TTL keeps an idle watch", async () => {
    expect(await expiredAfterTtl({ android: 10 })).toEqual([]);
  });
});
