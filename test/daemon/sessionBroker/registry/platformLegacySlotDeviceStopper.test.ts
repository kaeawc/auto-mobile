import { expect, test } from "bun:test";
import type { DeviceInfo } from "../../../../src/models/DeviceInfo";
import type {
  DeviceImageDiscovery,
  BootedDeviceDiscovery,
} from "../../../../src/devices/deviceUtils";
import { PlatformLegacySlotDeviceStopper } from "../../../../src/daemon/sessionBroker/registry/platformLegacySlotDeviceStopper";
import type { AdbDeviceState } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { EmulatorHostProcessRow } from "../../../../src/utils/android-cmdline-tools/EmulatorProcessStop";

class FakePlatform {
  image: DeviceInfo = {
    name: "amslot-old",
    platform: "android",
    deviceId: "emulator-5554",
    isRunning: true,
  };
  complete = true;
  transition = false;
  states: AdbDeviceState[] = [];
  processes: EmulatorHostProcessRow[] | undefined = [];
  readonly reads: string[] = [];
  readonly stopped: string[] = [];
  async getDeviceImagesDetailed(): Promise<DeviceImageDiscovery> {
    return {
      devices: [this.image],
      succeededPlatforms: new Set(this.complete ? [this.image.platform] : []),
    };
  }
  async getBootedDevicesDetailed(): Promise<BootedDeviceDiscovery> {
    return {
      devices: this.image.isRunning ? [{ ...this.image, deviceId: this.image.deviceId! }] : [],
      succeededPlatforms: new Set(this.complete ? [this.image.platform] : []),
      succeededSources: new Set(this.complete ? ["ios-simulator"] : []),
      transitionalSimulators: this.transition
        ? [{ device: { ...this.image, deviceId: this.image.deviceId! }, state: "Shutting Down" }]
        : [],
    };
  }
  async killDevice(device: { name: string }): Promise<void> {
    this.stopped.push(device.name);
    this.image.isRunning = false;
  }
  port() {
    return new PlatformLegacySlotDeviceStopper(this, {
      readStates: async () => {
        this.reads.push("states");
        return this.states;
      },
      processes: {
        read: async () => {
          this.reads.push("processes");
          return { value: this.processes, error: "unreadable" };
        },
      },
    });
  }
}
const signal = new AbortController().signal;
const target = { platform: "android" as const, stableId: "amslot-old", name: "amslot-old" };

test("Android shutdown reads states before the newer process table snapshot", async () => {
  const fake = new FakePlatform();
  fake.image.isRunning = false;
  expect((await fake.port().inspect(target, signal))?.isRunning).toBe(false);
  expect(fake.reads).toEqual(["states", "processes"]);
});

test("retirement uses normal kill port and leaves the image present on disk", async () => {
  const fake = new FakePlatform();
  const port = fake.port();
  const before = await port.inspect(target, signal);
  expect(before?.isRunning).toBe(true);
  await port.stop(before!, signal);
  expect((await port.inspect(target, signal))?.isRunning).toBe(false);
  expect(fake.stopped).toEqual(["amslot-old"]);
  expect(fake.image.name).toBe("amslot-old");
});
test.each(["offline", "pre-adb", "unreadable", "incomplete", "unknown-state"])(
  "%s evidence never confirms a stopped Android device",
  async (kind) => {
    const fake = new FakePlatform();
    fake.image.isRunning = false;
    if (kind === "offline") {
      fake.states = [{ deviceId: "emulator-5554", state: "offline" }];
    }
    if (kind === "pre-adb") {
      fake.processes = [
        { pid: 40, ppid: 1, command: "/sdk/qemu-system-aarch64 -avd amslot-old -port 5554" },
      ];
    }
    if (kind === "unreadable") {
      fake.processes = undefined;
    }
    if (kind === "incomplete") {
      fake.complete = false;
    }
    if (kind === "unknown-state") {
      fake.image.isRunningStateKnown = false;
    }
    await expect(fake.port().inspect(target, signal)).rejects.toThrow();
    expect(fake.stopped).toEqual([]);
  },
);
test("a different current device with the same iOS id is reported by its actual name", async () => {
  const fake = new FakePlatform();
  fake.image = { platform: "ios", name: "Personal simulator", deviceId: "UDID", isRunning: true };
  const current = await fake
    .port()
    .inspect({ platform: "ios", stableId: "UDID", name: "amslot-old" }, signal);
  expect(current?.name).toBe("Personal simulator");
  expect(fake.stopped).toEqual([]);
});

test.each(["offline", "unauthorized"])(
  "%s emulator with a unique personal AVD process does not defer retirement",
  async (state) => {
    const fake = new FakePlatform();
    fake.image.isRunning = false;
    fake.states = [{ deviceId: "emulator-5556", state }];
    fake.processes = [
      { pid: 40, ppid: 1, command: "/sdk/qemu-system-aarch64 -avd Pixel_8_Personal -port 5556" },
    ];
    expect((await fake.port().inspect(target, signal))?.isRunning).toBe(false);
    expect(fake.stopped).toEqual([]);
  },
);

test.each(["-avd Pixel_8_Personal -port=5556", "@Pixel_8_Personal -port 5556"])(
  "offline unrelated emulator with %s does not defer retirement",
  async (args) => {
    const fake = new FakePlatform();
    fake.image.isRunning = false;
    fake.states = [{ deviceId: "emulator-5556", state: "offline" }];
    fake.processes = [{ pid: 40, ppid: 1, command: `/sdk/qemu-system-aarch64 ${args}` }];
    expect((await fake.port().inspect(target, signal))?.isRunning).toBe(false);
    expect(fake.stopped).toEqual([]);
  },
);

test.each([
  "amslot-other",
  "ambroker-other",
  "missing-avd",
  "no-process",
  "two-processes",
  "second-missing-avd",
  "wrong-port",
  "not-qemu",
])("offline emulator with %s identity still defers retirement", async (kind) => {
  const fake = new FakePlatform();
  fake.image.isRunning = false;
  fake.states = [{ deviceId: "emulator-5556", state: "offline" }];
  const personal = {
    pid: 40,
    ppid: 1,
    command: "/sdk/qemu-system-aarch64 -avd Pixel_8_Personal -port 5556",
  };
  fake.processes = [personal];
  if (kind === "amslot-other" || kind === "ambroker-other") {
    fake.processes = [{ ...personal, command: `/sdk/qemu-system-aarch64 -avd ${kind} -port 5556` }];
  } else if (kind === "missing-avd") {
    fake.processes = [{ ...personal, command: "/sdk/qemu-system-aarch64 -port 5556" }];
  } else if (kind === "no-process") {
    fake.processes = [];
  } else if (kind === "two-processes") {
    fake.processes.push({ ...personal, pid: 41 });
  } else if (kind === "second-missing-avd") {
    fake.processes.push({ ...personal, pid: 41, command: "/sdk/qemu-system-aarch64 -port 5556" });
  } else if (kind === "wrong-port") {
    fake.processes = [
      { ...personal, command: "/sdk/qemu-system-aarch64 -avd Pixel_8_Personal -port 5558" },
    ];
  } else if (kind === "not-qemu") {
    fake.processes = [{ ...personal, command: "/sdk/emulator -avd Pixel_8_Personal -port 5556" }];
  }
  await expect(fake.port().inspect(target, signal)).rejects.toThrow("offline or unauthorized");
  expect(fake.stopped).toEqual([]);
});

test("offline personal emulator with an unreadable process table keeps the process-table error", async () => {
  const fake = new FakePlatform();
  fake.image.isRunning = false;
  fake.states = [{ deviceId: "emulator-5556", state: "offline" }];
  fake.processes = undefined;
  await expect(fake.port().inspect(target, signal)).rejects.toThrow(
    "Cannot confirm legacy emulator process absence: unreadable",
  );
  expect(fake.stopped).toEqual([]);
});
test("a transitional simulator cannot be mistaken for stopped", async () => {
  const fake = new FakePlatform();
  fake.image = { platform: "ios", name: "amslot-ios", deviceId: "UDID", isRunning: false };
  fake.transition = true;
  await expect(
    fake.port().inspect({ platform: "ios", stableId: "UDID", name: null }, signal),
  ).rejects.toThrow("transitioning");
});
test("interrupted creation without an id resolves by its recorded product name", async () => {
  const fake = new FakePlatform();
  expect((await fake.port().inspect({ ...target, stableId: null }, signal))?.name).toBe(
    "amslot-old",
  );
  expect(
    await fake.port().inspect({ ...target, stableId: "different-avd" }, signal),
  ).toBeUndefined();
});
