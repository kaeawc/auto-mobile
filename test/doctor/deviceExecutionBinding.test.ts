import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { checkAndroidIntegritySignals } from "../../src/doctor/checks/androidIntegrity";
import { checkCtrlProxy, checkWorkProfileAccessibility } from "../../src/doctor/checks/automobile";
import {
  AdmittingAdbClientFactory,
  type AdbClientFactory,
} from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { runWithDeviceExecutionBinding } from "../../src/utils/deviceExecutionBinding";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceExecutionBinding } from "../fakes/FakeDeviceExecutionBinding";

const target: BootedDevice = {
  name: "Target",
  platform: "android",
  deviceId: "emulator-5558",
};
const unrelated: BootedDevice = {
  name: "Other",
  platform: "android",
  deviceId: "emulator-5556",
};

describe("doctor execution binding", () => {
  const checks = [
    {
      name: "integrity",
      run: (factory: AdbClientFactory) => checkAndroidIntegritySignals(factory),
    },
    { name: "CtrlProxy fleet", run: (factory: AdbClientFactory) => checkCtrlProxy(factory) },
    {
      name: "work profiles",
      run: (factory: AdbClientFactory) => checkWorkProfileAccessibility(factory),
    },
    {
      name: "CtrlProxy target",
      targetDeviceId: target.deviceId,
      run: (factory: AdbClientFactory) => checkCtrlProxy(factory, {}, {}, target.deviceId),
    },
  ];
  for (const check of checks) {
    test(`${check.name} binds only an explicit target and preserves admission`, async () => {
      const adb = new FakeAdbExecutor();
      adb.setDevices([unrelated, target]);
      const binding = new FakeDeviceExecutionBinding();
      const admitted: string[] = [];
      const factory = new AdmittingAdbClientFactory(new FakeAdbClientFactory(adb), {
        admissionGate: {
          assertDeviceActionable: (id) => {
            admitted.push(id);
          },
        },
      });
      await runWithDeviceExecutionBinding(binding, async () => {
        const result = await check.run(factory);
        expect(result.message).toContain(target.deviceId);
        const expectedIds = check.targetDeviceId
          ? [target.deviceId]
          : [unrelated.deviceId, target.deviceId];
        expect([...new Set(admitted)]).toEqual(expectedIds);
        expect([...new Set(binding.deviceIds)]).toEqual(
          check.targetDeviceId ? [target.deviceId] : [],
        );
        // The surrounding tool execution regains its binding after diagnostic reads.
        factory.create(target);
        expect(binding.deviceIds.at(-1)).toBe(target.deviceId);
      });
    });
  }
});
