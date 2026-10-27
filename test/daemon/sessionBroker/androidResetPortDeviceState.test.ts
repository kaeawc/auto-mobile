import { ActionableError } from "../../../src/models/ActionableError";
import { sequenceBackoff } from "../../../src/utils/Backoff";
import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceMutationInput,
  MutationValue,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { AdbPowerClient } from "../../../src/features/utility/power/AndroidPowerClient";
import { DeviceStateMutationPriorReader } from "../../../src/server/deviceMutationDeviceStatePriorReader";
import type { AdbCommandRunner } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakePowerAdb } from "../../fakes/FakePowerAdb";
import { FakeTimer } from "../../fakes/FakeTimer";

const present = (value: unknown): MutationValue => ({ state: "present", value }) as MutationValue;
const ABSENT: MutationValue = { state: "absent" };
const UNOBSERVABLE: MutationValue = { state: "unobservable" };
const mutation = (kind: string, key: string, priorValue: MutationValue): DeviceMutationInput => ({
  kind,
  key,
  priorValue,
  toolName: "setDeviceState",
});

function makeContext(): DeviceMutationResetContext {
  return {
    scope: { deviceId: "emulator-5554", incarnation: "resource", sessionUuid: "session" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
  };
}

/** Runs the port's shell commands against the stateful power fake, as argv. */
function powerRunner(power: FakePowerAdb): AdbCommandRunner {
  return {
    executeCommand: (command) =>
      power.execute(command.split(" ").map((word) => word.replace(/^'|'$/g, ""))),
  };
}

describe("AndroidDeviceMutationResetPort setDeviceState reverts", () => {
  let adb: FakeAdbExecutor;
  let port: AndroidDeviceMutationResetPort;
  let timer: FakeTimer;
  const context = makeContext();

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    timer = new FakeTimer();
    port = new AndroidDeviceMutationResetPort(adb, timer);
  });

  describe("connectivity and Do Not Disturb vocabulary", () => {
    test("Bluetooth, which the settings clean cannot toggle, and the other radios restore", async () => {
      for (const [key, prior] of [
        ["bluetoothEnabled", false],
        ["wifiEnabled", true],
        ["airplaneMode", false],
        ["locationEnabled", true],
      ] as const) {
        await port.revert(mutation("device-setting", key, present(prior)), context);
      }
      expect(adb.getExecutedCommands()).toEqual([
        "shell svc bluetooth disable",
        "shell svc wifi enable",
        "shell cmd connectivity airplane-mode disable",
        "shell cmd location set-location-enabled true",
      ]);
    });

    test("Do Not Disturb restores its mode through the notification service", async () => {
      await port.revert(mutation("device-setting", "doNotDisturb", present("priority")), context);
      expect(adb.getExecutedCommands()).toEqual(["shell cmd notification set_dnd priority"]);
    });

    test("an unreadable or foreign prior is not restorable", () => {
      expect(port.canRevert(mutation("device-setting", "wifiEnabled", UNOBSERVABLE))).toBe(false);
      expect(port.canRevert(mutation("device-setting", "wifiEnabled", present("on")))).toBe(false);
      expect(port.canRevert(mutation("device-setting", "doNotDisturb", present("loud")))).toBe(
        false,
      );
      expect(
        port.canRevert(mutation("device-setting", "screenLock", present({ type: "none" }))),
      ).toBe(false);
    });
  });

  describe("power controls", () => {
    let power: FakePowerAdb;
    let client: AdbPowerClient;
    let reader: DeviceStateMutationPriorReader;
    const device = { name: "emu", platform: "android", deviceId: "emulator-5554" } as const;

    beforeEach(() => {
      power = new FakePowerAdb();
      client = new AdbPowerClient(power);
      reader = new DeviceStateMutationPriorReader(() => client);
      timer.enableAutoAdvance();
      port = new AndroidDeviceMutationResetPort(
        powerRunner(power),
        timer,
        sequenceBackoff([250, 500, 1000]),
      );
    });

    /** Journals a control the way the recording does: the prior is read before the change. */
    async function journal(key: string): Promise<DeviceMutationInput> {
      const [prior] = await reader.read(device, [{ kind: "device-setting", key }]);
      return mutation("device-setting", key, prior!);
    }

    test("ignored unforce rejects after the injected bounded Doze poll", async () => {
      const entry = await journal("power:doze");
      await client.forceDoze("deep");
      power.ignoring.add("deviceidle unforce");
      const result = port.revert(entry, context);
      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toThrow("could not confirm power:doze");
      expect(timer.getSleepHistory()).toEqual([250, 500, 1000, 1000, 250]);
      expect(timer.now()).toBe(3000);
    });

    test("Doze settles after two transient readings", async () => {
      const entry = await journal("power:doze");
      await client.forceDoze("deep");
      power.idleSettleReads = 2;
      await port.revert(entry, context);
      expect(timer.getSleepHistory()).toEqual([250, 500]);
      expect((await client.readDoze()).mode).toBe("off");
    });

    test("a screen the session slept is woken after the unforce so the Doze read-back settles (#15168)", async () => {
      const entry = await journal("power:doze");
      await client.forceDoze("deep");
      power.idleLingersWhileAsleep = true;
      power.setScreenState(false);
      await port.revert(entry, context);
      expect(power.getExecutedCommands().filter((c) => c.includes("KEYCODE_WAKEUP"))).toHaveLength(
        1,
      );
      expect((await client.readDoze()).mode).toBe("off");
      expect(await power.isScreenOn()).toBe(true);
    });

    test("an awake screen is not sent a wake key by the Doze revert", async () => {
      const entry = await journal("power:doze");
      await client.forceDoze("deep");
      await port.revert(entry, context);
      expect(power.getExecutedCommands().some((c) => c.includes("KEYCODE_WAKEUP"))).toBe(false);
    });

    test("a failed wake is logged and the Doze read-back stays authoritative (#15168)", async () => {
      const entry = await journal("power:doze");
      await client.forceDoze("deep");
      power.idleLingersWhileAsleep = true;
      power.setScreenState(false);
      power.failing.add("KEYCODE_WAKEUP");
      await expect(port.revert(entry, context)).rejects.toThrow("could not confirm power:doze");
      // Without the lingering idle the wake failure alone does not fail the revert.
      power.idleLingersWhileAsleep = false;
      await client.forceDoze("deep");
      power.setScreenState(false);
      await port.revert(entry, context);
      expect((await client.readDoze()).mode).toBe("off");
    });

    test("refused light Doze re-force is caught by read-back", async () => {
      await client.forceDoze("light");
      const entry = await journal("power:doze");
      power.lightEnabled = false;
      await expect(port.revert(entry, context)).rejects.toThrow("could not confirm power:doze");
    });

    test("Doze poll clamps to the remaining reset deadline", async () => {
      const entry = await journal("power:doze");
      await client.forceDoze("deep");
      power.ignoring.add("deviceidle unforce");
      await expect(
        port.revert(entry, { ...context, deadlineMs: timer.now() + 1000 }),
      ).rejects.toBeInstanceOf(ActionableError);
      expect(timer.getSleepHistory()).toEqual([250, 500, 250]);
      expect(timer.now()).toBe(1000);
    });

    test("Doze read-back errors reject with ActionableError", async () => {
      const entry = await journal("power:doze");
      power.failing.add("deviceidle get");
      await expect(port.revert(entry, context)).rejects.toBeInstanceOf(ActionableError);
    });

    test("a Doze polling read error propagates instead of becoming a mismatch", async () => {
      const entry = await journal("power:doze");
      await client.forceDoze("deep");
      power.ignoring.add("deviceidle unforce");
      const runner = powerRunner(power);
      port = new AndroidDeviceMutationResetPort(
        {
          executeCommand: (command, options) => {
            if (timer.now() > 0) {
              power.failing.add("deviceidle get");
            }
            return runner.executeCommand(command, options);
          },
        },
        timer,
        sequenceBackoff([250]),
      );
      await expect(port.revert(entry, context)).rejects.toThrow("could not read back device state");
      expect(timer.getSleepHistory()).toEqual([250]);
    });

    test.each([
      ["battery", { level: 40, charging: "usb", faked: true }, "dumpsys battery set"],
      ["thermal", { status: 2, override: true }, "thermalservice override-status"],
      ["dataSaver", true, "netpolicy set"],
      ["batterySaver", true, "settings put"],
      ["standby:com.example.app", "rare", "am set-standby-bucket"],
      ["inactive:com.example.app", true, "am set-inactive"],
    ])("ignored %s restore rejects on mismatch", async (field, prior, command) => {
      power.ignoring.add(command);
      await expect(
        port.revert(mutation("device-setting", `power:${field}`, present(prior)), context),
      ).rejects.toThrow(`could not confirm power:${field}`);
    });

    test("an explicit battery saver false prior must read back as false", async () => {
      power.ignoring.add("settings put");
      await expect(
        port.revert(mutation("device-setting", "power:batterySaver", present(false)), context),
      ).rejects.toThrow("could not confirm power:batterySaver");
    });

    test("a faked battery goes back to the real one", async () => {
      const entry = await journal("power:battery");
      await client.setBatteryCharging("none");
      await client.setBatteryLevel(15);
      expect((await client.readBattery()).faked).toBe(true);
      await port.revert(entry, context);
      expect(await client.readBattery()).toMatchObject({
        level: 100,
        charging: "ac",
        faked: false,
      });
    });

    test("a battery that was already faked goes back to the fake it had", async () => {
      await client.setBatteryCharging("usb");
      await client.setBatteryLevel(40);
      const entry = await journal("power:battery");
      await client.resetBattery();
      await client.setBatteryCharging("none");
      await port.revert(entry, context);
      expect(await client.readBattery()).toMatchObject({ level: 40, charging: "usb", faked: true });
    });

    test("forced Doze is left and a prior Doze is re-forced", async () => {
      const entry = await journal("power:doze");
      await client.forceDoze("deep");
      await port.revert(entry, context);
      expect((await client.readDoze()).mode).toBe("off");
      await client.forceDoze("light");
      const forced = await journal("power:doze");
      await client.unforceDoze();
      await port.revert(forced, context);
      expect((await client.readDoze()).mode).toBe("light");
    });

    test("thermal override, Data Saver, battery saver, standby bucket and inactive state restore", async () => {
      power.restrictBackground = true;
      power.lowPower = "1";
      power.thermal = { override: true, status: 2 };
      power.buckets.set("com.example.app", 20);
      power.inactive.set("com.example.app", true);
      const entries = [
        await journal("power:thermal"),
        await journal("power:dataSaver"),
        await journal("power:batterySaver"),
        await journal("power:standby:com.example.app"),
        await journal("power:inactive:com.example.app"),
      ];
      await client.resetThermal();
      await client.setDataSaver(false);
      await client.setBatterySaver(false);
      await client.setStandbyBucket("com.example.app", "restricted");
      await client.setInactive("com.example.app", false);
      for (const entry of entries.reverse()) {
        await port.revert(entry, context);
      }
      expect(await client.readThermal()).toEqual({ status: 2, override: true });
      expect(await client.readDataSaver()).toBe(true);
      expect(await client.readBatterySaver()).toBe(true);
      expect(await client.readStandbyBucket("com.example.app")).toBe("working_set");
      expect(await client.readInactive("com.example.app")).toBe(true);
    });

    test("an unset battery saver is deleted again, and a thermal prior with no override resets", async () => {
      const entry = await journal("power:batterySaver");
      expect(entry.priorValue).toEqual(ABSENT);
      power.lowPower = "1";
      power.thermal = { status: 4, override: true };
      await port.revert(entry, context);
      await port.revert(
        mutation("device-setting", "power:thermal", present({ status: 0, override: false })),
        context,
      );
      expect(await client.readBatterySaver()).toBeUndefined();
      expect(await client.readThermal()).toEqual({ status: 0, override: false });
    });

    test("a prior the tool cannot write back is not restorable", () => {
      expect(
        port.canRevert(
          mutation("device-setting", "power:standby:com.example.app", present("exempted")),
        ),
      ).toBe(false);
      expect(port.canRevert(mutation("device-setting", "power:battery", present("full")))).toBe(
        false,
      );
      expect(port.canRevert(mutation("device-setting", "power:doze", UNOBSERVABLE))).toBe(false);
      expect(
        port.canRevert(mutation("device-setting", "power:standby:../x", present("rare"))),
      ).toBe(false);
      expect(port.canRevert(mutation("device-setting", "power:unknown", present(true)))).toBe(
        false,
      );
    });
  });

  describe("emulator network shaping", () => {
    test("shaping returns to the status read before it, with the radios back on", async () => {
      adb.setCommandResponse("emu ", createExecResult("OK\n", ""));
      await port.revert(
        mutation(
          "network-condition",
          "device",
          present({ delayMs: 300, downloadKbps: 1200, uploadKbps: 200 }),
        ),
        context,
      );
      expect(adb.getExecutedCommands()).toEqual([
        "emu network delay 300:300",
        "emu network speed 200:1200",
        "emu gsm data on",
        "shell svc wifi enable",
      ]);
    });

    test("an unshaped prior restores full speed and no delay", async () => {
      adb.setCommandResponse("emu ", createExecResult("OK\n", ""));
      await port.revert(
        mutation("network-condition", "device", present({ delayMs: 0, downloadKbps: 0 })),
        context,
      );
      expect(adb.getExecutedCommands().slice(0, 2)).toEqual([
        "emu network delay none",
        "emu network speed full",
      ]);
    });

    test("a console refusal fails the revert so keep-booted reset escalates", async () => {
      adb.setCommandResponse("emu ", createExecResult("KO: unknown command\n", ""));
      await expect(
        port.revert(mutation("network-condition", "device", present({ delayMs: 0 })), context),
      ).rejects.toThrow("Android reset command failed to confirm success");
    });

    test("an unreadable prior, a per-app key and an SDK key are not restorable", () => {
      expect(port.canRevert(mutation("network-condition", "device", UNOBSERVABLE))).toBe(false);
      expect(port.canRevert(mutation("network-condition", "device", present("3g")))).toBe(false);
      expect(
        port.canRevert(mutation("network-condition", '["app","com.example"]', present({}))),
      ).toBe(false);
      expect(port.canRevert(mutation("network-condition", "sdk:capture", present({})))).toBe(false);
    });
  });

  describe("wall clock", () => {
    const prior = present({ instant: "2026-10-21T00:00:00.000Z", automaticTime: true });

    test("a drifted clock is set to host time and auto time put back", async () => {
      timer.advanceTime(1_790_000_000_500);
      await port.revert(mutation("clock", "device", prior), context);
      const [command] = adb.getExecutedCommands();
      expect(command).toStartWith("shell sh -c ");
      expect(command).toContain("date -u @1790000000");
      expect(command).toContain("settings put global auto_time 0 &&");
      expect(command).toContain("settings put global auto_time 1");
      expect(command).toContain("-gt 2 ]");
    });

    test("the original auto_time off is written back as 0", async () => {
      await port.revert(
        mutation(
          "clock",
          "device",
          present({ instant: "2026-10-21T00:00:00Z", automaticTime: false }),
        ),
        context,
      );
      expect(adb.getExecutedCommands()[0]).toContain("; settings put global auto_time 0");
    });

    test("the timezone and an unreadable or foreign clock prior keep their old behavior", () => {
      expect(port.canRevert(mutation("clock", "device", UNOBSERVABLE))).toBe(false);
      expect(
        port.canRevert(mutation("clock", "device", present({ instant: "x", automaticTime: true }))),
      ).toBe(false);
      expect(port.canRevert(mutation("clock", "device", present("2026-10-21T00:00:00Z")))).toBe(
        false,
      );
      expect(port.canRevert(mutation("clock", "timezone", present("Europe/Paris")))).toBe(true);
    });
  });
});
