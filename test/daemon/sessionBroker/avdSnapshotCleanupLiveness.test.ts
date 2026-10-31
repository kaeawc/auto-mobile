import { unknownEmulatorName } from "../../../src/utils/android-cmdline-tools/emulatorReadinessEvaluation";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ProcessTableReader } from "../../../src/devices/bootAdmission/processTableRetry";
import { parsePsSnapshot } from "../../../src/devices/bootAdmission/psSnapshot";
import { ActionableError } from "../../../src/models/ActionableError";
import { emulatorProcessArguments } from "../../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeProcFs } from "../../fakes/FakeProcFs";
import { FakeTimer } from "../../fakes/FakeTimer";
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

function procFixture() {
  const procFs = new FakeProcFs();
  const capture = (name: string) =>
    readFileSync(new URL(`../../fixtures/android-boot-admission/${name}`, import.meta.url), "utf8");
  const command = parsePsSnapshot(capture("ps-snapshot-one-running-emulator.txt")).rows.find(
    (row) => row.command.includes("qemu-system-"),
  )!.command;
  procFs.entries = ["13", "42"];
  for (const pid of procFs.entries) {
    procFs.files.set(`/proc/${pid}/status`, capture("proc-alpine-normal-status.txt"));
  }
  procFs.files.set("/proc/13/cmdline", capture("proc-alpine-normal-cmdline.bin"));
  procFs.files.set("/proc/42/cmdline", command.split(" ").join("\0") + "\0");
  const executor = new FakeHostCommandExecutor();
  executor.setCommandError("ps", Object.assign(new Error("ps unavailable"), { code: "ENOENT" }));
  const timer = new FakeTimer();
  const table = new ProcessTableReader(executor, { procFs, timer });
  return {
    procFs,
    timer,
    avdName: emulatorProcessArguments(command).avdName!,
    liveness: new ProcessTableAvdSnapshotCleanupLiveness(table, async () => []),
  };
}

describe("production snapshot cleanup liveness with injected discovery", () => {
  test.each(["EACCES", "EPERM", "unparseable"])(
    "incomplete proc inventory refuses cleanup when emulator status is %s",
    async (failure) => {
      const { procFs, timer, avdName, liveness } = procFixture();
      const path = "/proc/42/status";
      procFs.files.set(
        path,
        failure === "unparseable"
          ? String(procFs.files.get(path)).replace(/^PPid:.*$/m, "PPid:\tinvalid")
          : Object.assign(new Error("emulator status denied"), { code: failure }),
      );
      await expect(liveness.hasLiveProcess(avdName)).rejects.toBeInstanceOf(ActionableError);
      expect(timer.getSleepCallCount()).toBe(0);
    },
  );

  test("readable proc inventory answers normally and ignores exited processes", async () => {
    const { procFs, timer, avdName, liveness } = procFixture();
    procFs.entries.push("43"); // Missing status is the fake's ENOENT exit race.
    expect(await liveness.hasLiveProcess(avdName)).toBe(true);
    expect(await liveness.hasLiveProcess(`${avdName}-other`)).toBe(false);
    expect(timer.getSleepCallCount()).toBe(0);
  });

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
