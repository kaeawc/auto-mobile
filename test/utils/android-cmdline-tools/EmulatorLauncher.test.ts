import { beforeEach, describe, expect, test } from "bun:test";
import type { DeviceInfo } from "../../../src/models";
import {
  DefaultEmulatorLauncher,
  type EmulatorLauncherHost,
} from "../../../src/utils/android-cmdline-tools/EmulatorLauncher";
import {
  DefaultEmulatorPortReservations,
  resetEmulatorLaunchReservations,
} from "../../../src/utils/android-cmdline-tools/EmulatorPortReservations";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakePortAvailabilityChecker } from "../../fakes/FakePortAvailabilityChecker";
import { FakeTimer } from "../../fakes/FakeTimer";

/** Members the launch pre-flight touches; everything else fails loudly if reached. */
function createHost(overrides: Partial<EmulatorLauncherHost>): EmulatorLauncherHost {
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected host call: ${name}`);
  };
  return new Proxy(overrides as EmulatorLauncherHost, {
    get: (target, property: string) =>
      property in target ? target[property as keyof EmulatorLauncherHost] : unexpected(property),
  });
}

describe("DefaultEmulatorLauncher pre-flight", () => {
  let reservations: DefaultEmulatorPortReservations;

  beforeEach(() => {
    resetEmulatorLaunchReservations();
    const timer = new FakeTimer();
    reservations = new DefaultEmulatorPortReservations({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(),
      hostPortAvailabilityChecker: () => new FakePortAvailabilityChecker(),
    });
  });

  const avds = (...names: string[]): DeviceInfo[] =>
    names.map((name) => ({ name, platform: "android" }) as DeviceInfo);

  test("refuses an AVD that does not exist and lists the available ones", async () => {
    const launcher = new DefaultEmulatorLauncher(
      createHost({
        reservations: () => reservations,
        listAvds: async () => avds("Pixel_9", "Tab"),
      }),
    );

    await expect(launcher.startEmulatorProcess("Missing")).rejects.toThrow(
      "AVD 'Missing' not found. Available AVDs: Pixel_9, Tab",
    );
  });

  test("joins a launch already in flight in this process without spawning", async () => {
    reservations.claimInFlightLaunch("Pixel_9");
    const posterChecks: Array<string | undefined> = [];
    const launcher = new DefaultEmulatorLauncher(
      createHost({
        reservations: () => reservations,
        listAvds: async () => avds("Pixel_9"),
        assertCameraPosterColdBoot: (posterPath) => {
          posterChecks.push(posterPath);
        },
      }),
    );

    const launch = await launcher.startEmulatorProcess("Pixel_9", { cameraPosterPath: "p.png" });

    expect(launch).toEqual({ process: null, outcome: "joined-in-process-launch" });
    expect(posterChecks).toEqual(["p.png"]);
  });
});
