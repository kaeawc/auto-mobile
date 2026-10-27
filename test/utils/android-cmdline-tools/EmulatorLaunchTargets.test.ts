import type { HostChildProcess as ChildProcess } from "../../../src/utils/HostCommandExecutor";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { DefaultEmulatorLaunchTargets } from "../../../src/utils/android-cmdline-tools/EmulatorLaunchTargets";
import type { EmulatorDeviceIdReservation } from "../../../src/utils/android-cmdline-tools/EmulatorPortReservations";

function child(): ChildProcess {
  return new FakeChildProcess();
}

function booted(name: string, deviceId: string): BootedDevice {
  return { name, deviceId, platform: "android" };
}

function targets() {
  const recorded: { child: ChildProcess; reservation: EmulatorDeviceIdReservation }[] = [];
  const subject = new DefaultEmulatorLaunchTargets(() => ({
    recordReservedEmulatorDeviceId: (process, reservation) => {
      recorded.push({ child: process, reservation });
    },
  }));
  return { subject, recorded };
}

describe("DefaultEmulatorLaunchTargets", () => {
  test("lookups on a missing child return undefined", () => {
    const { subject } = targets();
    expect(subject.getLaunchTargetDeviceId(null)).toBeUndefined();
    expect(subject.getLaunchError(undefined)).toBeUndefined();
    expect(subject.getLaunchErrorFinalization(null)).toBeUndefined();
  });

  test("captures the target serial from process output once and keeps the first", () => {
    const { subject } = targets();
    const process = child();
    subject.captureLaunchTargetDeviceId(process, "no serial here");
    expect(subject.getLaunchTargetDeviceId(process)).toBeUndefined();
    subject.captureLaunchTargetDeviceId(process, "emulator: console on port: 5556");
    subject.captureLaunchTargetDeviceId(process, "listening as emulator-5560");
    expect(subject.getLaunchTargetDeviceId(process)).toBe("emulator-5556");
  });

  test("a reserved console port is recorded on the reservations and as the target", () => {
    const { subject, recorded } = targets();
    const process = child();
    const reservation: EmulatorDeviceIdReservation = {
      deviceId: "emulator-5554",
      ports: { consolePort: 5554, adbPort: 5555 },
      appendPort: true,
      avdName: "Pixel",
    };
    subject.recordReservedEmulatorDeviceId(process, reservation);
    expect(recorded).toEqual([{ child: process, reservation }]);
    expect(subject.getLaunchTargetDeviceId(process)).toBe("emulator-5554");
  });

  test("an exact AVD-name match records its serial as the target", () => {
    const { subject } = targets();
    const process = child();
    const match = booted("Pixel", "emulator-5558");
    const found = subject.findNamedEmulator("Pixel", process, [
      booted("Other", "emulator-5554"),
      match,
    ]);
    expect(found).toEqual({ emulator: match });
    expect(subject.getLaunchTargetDeviceId(process)).toBe("emulator-5558");
  });

  test("no name match finds nothing and records nothing", () => {
    const { subject } = targets();
    const process = child();
    expect(subject.findNamedEmulator("Pixel", process, [booted("Other", "emulator-5554")])).toEqual(
      {},
    );
    expect(subject.getLaunchTargetDeviceId(process)).toBeUndefined();
  });

  test("launch errors are looked up per child and rethrown on demand", async () => {
    const { subject } = targets();
    const process = child();
    const error = new ActionableError("early exit");
    const finalization = Promise.resolve<ActionableError | undefined>(error);
    subject.launchErrors.set(process, error);
    subject.launchErrorFinalizations.set(process, finalization);
    expect(subject.getLaunchError(process)).toBe(error);
    expect(subject.getLaunchErrorFinalization(process)).toBe(finalization);
    expect(() => subject.throwLaunchError(subject.getLaunchError(process))).toThrow("early exit");
    expect(() => subject.throwLaunchError(undefined)).not.toThrow();
  });
});
