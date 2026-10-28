import { describe, expect, test } from "bun:test";
import type { BootedDeviceDiscovery } from "../../../src/devices/deviceUtils";
import type { SomePlatform } from "../../../src/models";
import { UnconfirmedRecoveryShutdownError } from "../../../src/daemon/UnconfirmedRecoveryShutdownError";
import {
  DevicePoolAndroidRecovery,
  type AndroidRecoveryCallbacks,
} from "../../../src/daemon/devicePoolParts/androidRecovery";
import type { StopDiscoveredEmulatorOptions } from "../../../src/daemon/devicePoolParts/contracts";
import {
  DevicePoolEmulatorLifecycle,
  type EmulatorLifecycleCallbacks,
} from "../../../src/daemon/devicePoolParts/emulatorLifecycle";
import { DevicePoolState } from "../../../src/daemon/devicePoolParts/state";
import type { PooledDevice } from "../../../src/daemon/devicePoolTypes";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { FakeTimer } from "../../fakes/FakeTimer";

// #15671: the emulator-shutdown confirmation takes its caller's cancellation signal as an
// explicit option instead of reading the ambient abort context, so these calls deliberately run
// OUTSIDE any runWithAbortSignal scope: only the threaded signal can stop them.

const disconnected: PooledDevice = {
  id: "emulator-5554",
  name: "Pixel",
  platform: "android",
  avdName: "Pixel",
  sessionId: null,
  status: "idle",
  lastUsedAt: 0,
  assignmentCount: 0,
  errorCount: 0,
  incarnation: 1,
};

/** Discovery that parks until released, so a test can cancel while the shutdown is mid-call. */
class GatedDiscoveryDeviceManager extends FakeDeviceManager {
  private readonly started = Promise.withResolvers<void>();
  private readonly gate = Promise.withResolvers<void>();
  discoveries = 0;

  get discoveryStarted(): Promise<void> {
    return this.started.promise;
  }

  releaseDiscovery(): void {
    this.gate.resolve();
  }

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    this.discoveries++;
    this.started.resolve();
    await this.gate.promise;
    return super.getBootedDevicesDetailed(platform);
  }
}

const unexpected = (name: string) => (): never => {
  throw new Error(`unexpected ${name}`);
};

function emulatorLifecycle(manager: FakeDeviceManager): DevicePoolEmulatorLifecycle {
  const state = new DevicePoolState();
  state.timer = new FakeTimer();
  state.deviceManager = manager;
  const callbacks: EmulatorLifecycleCallbacks = {
    isPooledEntryCurrent: unexpected("isPooledEntryCurrent"),
    detachSessionForAndroidRecovery: unexpected("detachSessionForAndroidRecovery"),
    removeDevice: unexpected("removeDevice"),
    addDevice: unexpected("addDevice"),
  };
  return new DevicePoolEmulatorLifecycle(state, callbacks);
}

/** An adopt-only stop of an AVD the fresh discovery no longer lists: it resolves "stopped". */
function adoptOnlyStop(
  signal: AbortSignal | undefined,
  retained: Promise<unknown>[],
): StopDiscoveredEmulatorOptions {
  return {
    disconnectedDevice: disconnected,
    avdName: "Pixel",
    retainLeaseUntil: (settlement) => retained.push(settlement),
    adoptOnly: true,
    handoffOwner: Symbol("handoff"),
    preservedSessionId: undefined,
    preservedSession: undefined,
    signal,
  };
}

describe("DevicePoolEmulatorLifecycle.stopDiscoveredEmulatorByAvdName signal", () => {
  test("a cancel of the threaded signal mid-discovery stops the shutdown", async () => {
    const manager = new GatedDiscoveryDeviceManager();
    const lifecycle = emulatorLifecycle(manager);
    const controller = new AbortController();
    const retained: Promise<unknown>[] = [];

    const stop = lifecycle.stopDiscoveredEmulatorByAvdName(
      adoptOnlyStop(controller.signal, retained),
    );
    await manager.discoveryStarted;
    controller.abort(new Error("request cancelled"));
    // Discovery now answers "AVD gone"; without the threaded signal the stop would resolve.
    manager.releaseDiscovery();

    const error = await stop.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(UnconfirmedRecoveryShutdownError);
    expect(error instanceof Error ? error.cause : undefined).toEqual(
      new Error("request cancelled"),
    );
    // The in-flight shutdown is retained on the lease, and no second discovery ran.
    expect({ retained: retained.length, discoveries: manager.discoveries }).toEqual({
      retained: 1,
      discoveries: 1,
    });
  });

  test("with no signal the shutdown confirms as before", async () => {
    const manager = new GatedDiscoveryDeviceManager();
    manager.releaseDiscovery();
    const retained: Promise<unknown>[] = [];

    const result = await emulatorLifecycle(manager).stopDiscoveredEmulatorByAvdName(
      adoptOnlyStop(undefined, retained),
    );

    expect({ result, retained: retained.length }).toEqual({ result: "stopped", retained: 0 });
  });
});

/** The tracked-process stop needs the process lifecycle; these tests track no process. */
class UntrackedAndroidRecovery extends DevicePoolAndroidRecovery {
  override async stopTrackedEmulatorProcess(): Promise<void> {}
}

function androidRecovery(stops: StopDiscoveredEmulatorOptions[]): DevicePoolAndroidRecovery {
  const callbacks: AndroidRecoveryCallbacks = {
    shouldRebootDisconnectedAndroidDevice: (_device, _options): _device is never => false,
    stopEmulatorProcess: unexpected("stopEmulatorProcess"),
    getCompletedProcessExit: () => undefined,
    stopDiscoveredEmulatorByAvdName: async (options) => {
      stops.push(options);
      return "stopped";
    },
    isPreservedSessionCurrent: unexpected("isPreservedSessionCurrent"),
    bindOrReuseDeviceSession: unexpected("bindOrReuseDeviceSession"),
    getDevicesByPlatform: () => [],
    isPooledAndroidEmulator: unexpected("isPooledAndroidEmulator"),
    stableDeviceIdFor: unexpected("stableDeviceIdFor"),
    notifyDeviceStateChanged: unexpected("notifyDeviceStateChanged"),
    trackStartedDeviceProcess: unexpected("trackStartedDeviceProcess"),
  };
  return new UntrackedAndroidRecovery(new DevicePoolState(), callbacks);
}

describe("DevicePoolAndroidRecovery.stopAndroidEmulatorForRecovery signal", () => {
  test.each([
    ["the recovery's signal", new AbortController().signal],
    ["no signal", undefined],
  ])("forwards %s to the discovered-emulator stop", async (_label, signal) => {
    const stops: StopDiscoveredEmulatorOptions[] = [];

    const result = await androidRecovery(stops).stopAndroidEmulatorForRecovery({
      device: disconnected,
      avdName: "Pixel",
      retainLeaseUntil: () => {},
      allowActiveStop: true,
      handoffOwner: Symbol("handoff"),
      preservedSessionId: undefined,
      preservedSession: undefined,
      signal,
    });

    expect({ result, stops: stops.length }).toEqual({ result: "stopped", stops: 1 });
    expect(stops[0]?.signal).toBe(signal);
  });
});
