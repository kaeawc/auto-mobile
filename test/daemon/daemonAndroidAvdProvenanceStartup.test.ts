import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import type { AvdManager } from "../../src/utils/android-cmdline-tools/interfaces/AvdManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeTimer } from "../fakes/FakeTimer";

interface DaemonAndroidAvdProvenanceStartupInternals {
  warmAndroidAvdProvenanceCache(): void;
  androidAvdProvenanceWarmPromise?: Promise<unknown>;
}

class FakeDeviceSessionRepository extends DeviceSessionRepository {
  override async getSession(): Promise<undefined> {
    return undefined;
  }

  override async upsertActiveSession(): Promise<void> {}

  override async replaceLivenessOwnership(): Promise<void> {}
}

function buildDaemon(
  timer: FakeTimer,
  avdManagerFactory: () => Pick<AvdManager, "listDeviceImages">,
): Daemon {
  return new Daemon(
    {},
    new FakeInstalledAppsRepository(),
    timer,
    new FakeDeviceSessionRepository(),
    new CountingIdGenerator("daemon-session"),
    new FakeDatabaseInitializer(),
    new FakeStartupFailureTracker(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    avdManagerFactory,
  );
}

describe("Daemon Android AVD provenance startup warm", () => {
  beforeEach(() => {
    AndroidAvdProvenanceCache.resetForTests();
  });

  afterEach(() => {
    AndroidAvdProvenanceCache.resetForTests();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("populates the process-wide cache before a later cache-only read", async () => {
    const timer = new FakeTimer();
    const avdManager = new FakeAvdManager();
    const expected = {
      name: "Pixel_9_API_36",
      path: "/tmp/avd/Pixel_9_API_36.avd",
      target: "Google APIs",
      basedOn: "Android 16 google_apis/arm64-v8a",
    };
    avdManager.setListDeviceImagesResponse([expected]);
    const daemon = buildDaemon(timer, () => avdManager);
    const internals = daemon as unknown as DaemonAndroidAvdProvenanceStartupInternals;

    internals.warmAndroidAvdProvenanceCache();
    expect(internals.androidAvdProvenanceWarmPromise).toBeDefined();
    await internals.androidAvdProvenanceWarmPromise;

    expect(avdManager.getListDeviceImagesCalls()).toHaveLength(1);
    expect(AndroidAvdProvenanceCache.getInstance().getCachedByName()?.get(expected.name)).toEqual(
      expected,
    );
  });

  test("swallows a synchronous AVD manager factory failure", async () => {
    const daemon = buildDaemon(new FakeTimer(), () => {
      throw new Error("AVD manager unavailable");
    });
    const internals = daemon as unknown as DaemonAndroidAvdProvenanceStartupInternals;

    expect(() => internals.warmAndroidAvdProvenanceCache()).not.toThrow();
    expect(internals.androidAvdProvenanceWarmPromise).toBeDefined();
    await expect(internals.androidAvdProvenanceWarmPromise).resolves.toBeUndefined();
  });
});
