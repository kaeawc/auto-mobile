import { unknownEmulatorName } from "../../../src/utils/android-cmdline-tools/emulatorReadinessEvaluation";
import { describe, expect, test } from "bun:test";
import { ProcessTableAvdSnapshotCleanupLiveness } from "../../../src/daemon/sessionBroker/avdSnapshotCleanupLiveness";
import type { EmulatorProcessTableSource } from "../../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import type { BootedDevice } from "../../../src/models/DeviceInfo";

class FakeProcessTable implements EmulatorProcessTableSource {
  result: Awaited<ReturnType<EmulatorProcessTableSource["read"]>> = { value: [] };
  async read() {
    return this.result;
  }
}
class FakeCheckedInventory {
  error: Error | undefined;
  devices: BootedDevice[] = [];
  async list() {
    if (this.error) {
      throw this.error;
    }
    return this.devices;
  }
}
function fixture() {
  const table = new FakeProcessTable();
  const inventory = new FakeCheckedInventory();
  return {
    table,
    inventory,
    liveness: new ProcessTableAvdSnapshotCleanupLiveness(table, () => inventory.list()),
  };
}

describe("production snapshot cleanup liveness with injected discovery", () => {
  test.each(["-avd ambroker-stale", "@ambroker-stale", "-avd AMBROKER-STALE"])(
    "matches the AVD argument %s",
    async (args) => {
      const { table, liveness } = fixture();
      table.result = {
        value: [{ pid: 10, ppid: 1, command: `/sdk/qemu-system-aarch64 ${args} -port 5554` }],
      };
      expect(await liveness.hasLiveProcess("ambroker-stale")).toBe(true);
      expect(await liveness.hasLiveProcess("ambroker-stale-extra")).toBe(false);
    },
  );
  test("successful empty discovery is absence", async () => {
    const { liveness } = fixture();
    expect(await liveness.hasLiveProcess("ambroker-stale")).toBe(false);
    expect(await liveness.findLiveEmulatorSerial("ambroker-stale")).toBeNull();
  });
  test("unavailable process table throws instead of proving absence", async () => {
    const { table, liveness } = fixture();
    table.result = { error: "process discovery failed" };
    await expect(liveness.hasLiveProcess("ambroker-stale")).rejects.toThrow(
      "process discovery failed",
    );
  });
  test("unidentified emulator process throws instead of proving absence", async () => {
    const { table, liveness } = fixture();
    table.result = {
      value: [{ pid: 10, ppid: 1, command: "/sdk/qemu-system-aarch64 -port 5554" }],
    };
    await expect(liveness.hasLiveProcess("ambroker-stale")).rejects.toThrow("Cannot identify");
  });
  test("unresolved checked inventory identity throws instead of proving absence", async () => {
    const { inventory, liveness } = fixture();
    inventory.devices = [
      {
        deviceId: "emulator-5554",
        platform: "android",
        name: unknownEmulatorName("emulator-5554"),
      },
    ];
    await expect(liveness.findLiveEmulatorSerial("ambroker-stale")).rejects.toThrow(
      "Cannot identify",
    );
  });
  test("serial lookup finds the named AVD and propagates checked discovery failure", async () => {
    const { inventory, liveness } = fixture();
    inventory.devices = [
      { deviceId: "emulator-5554", platform: "android", name: "ambroker-stale" },
    ];
    expect(await liveness.findLiveEmulatorSerial("ambroker-stale")).toBe("emulator-5554");
    inventory.error = new Error("checked discovery failed");
    await expect(liveness.findLiveEmulatorSerial("ambroker-stale")).rejects.toThrow(
      "checked discovery failed",
    );
  });
});
