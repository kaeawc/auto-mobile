import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { wrapCommandError } from "../../../src/utils/CommandError";
import { errorMessage } from "../../../src/utils/describeUnknownError";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { runWithAbortSignal, getAbortSignal } from "../../../src/utils/AbortContext";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { DeviceTraits } from "../../../src/utils/android-cmdline-tools/deviceTraits";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import {
  createVehiclePropertyAccess,
  parsePropertyValue,
  resolveVehicleStateInjector,
} from "../../../src/features/deviceCondition/vehicleStateInjectors";
import { deviceConditionChanges } from "../../../src/features/deviceCondition/DeviceConditionTypes";
import { resolveIosRefusalInjector } from "../../../src/features/deviceCondition/iosRefusalInjector";

const userBuildRefusal = readFileSync(
  new URL("../../fixtures/android-car-service/car-service-user-build-refusal.txt", import.meta.url),
  "utf8",
);

const GEAR = "0x11400400";
const SPEED = "0x11600207";
const BRAKE = "0x11200402";
const NIGHT = "0x11200407";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

/** Synchronous fake-time sleeps leave renewal timeouts under each test's control. */
class VehicleTimer extends FakeTimer {
  override async sleep(ms: number): Promise<void> {
    const sleeping = super.sleep(ms);
    this.advanceTime(ms);
    await sleeping;
  }
}

class VehicleAdb extends FakeAdbExecutor {
  readonly timer = new VehicleTimer();
}

/** The VHAL store stays unchanged by event injection; effective state is separate. */
function vehicleAdb(
  initial: Record<string, string>,
  options: {
    injectFails?: boolean;
    nightIgnored?: boolean;
    sensorNight?: boolean;
    drivingStates?: string[];
  } = {},
) {
  const props = { ...initial };
  const log: string[] = [];
  const adb = new VehicleAdb();
  let streamEndsAt = 0;
  let dumpIndex = 0;
  adb.execute = (args) => {
    const command = args.join(" ");
    log.push(command);
    const get = /^shell cmd car_service get-property-value (\S+)$/.exec(command);
    if (get) {
      return Promise.resolve(execResult(`Value[int32Values: [${initial[get[1]]}]]`));
    }
    const inject = /^shell cmd car_service inject-vhal-event (\S+) 0 (\S+)$/.exec(command);
    if (inject) {
      if (options.injectFails) {
        return Promise.resolve(execResult("Unknown command: inject-vhal-event"));
      }
      // A single speed event cannot beat the still-running continuous stream.
      if (inject[1] !== SPEED || adb.timer.now() >= streamEndsAt) {
        props[inject[1]] = inject[2];
      }
      return Promise.resolve(execResult(""));
    }
    if (command.includes("inject-continuous-events")) {
      props[SPEED] = "10.0";
      streamEndsAt = adb.timer.now() + 10_100;
      return Promise.resolve(execResult(""));
    }
    if (command === "shell cmd uimode night") {
      return Promise.resolve(execResult(`Night mode: ${props[NIGHT] === "1" ? "yes" : "no"}`));
    }
    const night = /^shell cmd car_service day-night-mode (night|day|sensor)$/.exec(command);
    if (night) {
      if (!options.nightIgnored) {
        const sensorNight = options.sensorNight ?? initial[NIGHT] === "1";
        props[NIGHT] = (night[1] === "sensor" ? sensorNight : night[1] === "night") ? "1" : "0";
      }
      return Promise.resolve(execResult(`DayNightMode changed to: ${night[1]}`));
    }
    if (command.includes("CarDrivingStateService")) {
      const states = options.drivingStates;
      const state = Number(props[SPEED]) > 0 ? 2 : props[BRAKE] === "1" ? 0 : 1;
      const dump = states
        ? states[Math.min(dumpIndex++, states.length - 1)]
        : `Driving State Clients:\n  listener\nCurrent Driving State: ${state}\nother`;
      return Promise.resolve(execResult(dump));
    }
    return Promise.resolve(execResult(""));
  };
  return { adb, props, log, timer: adb.timer };
}

const PARKED = { [GEAR]: "4", [SPEED]: "0.0", [BRAKE]: "1", [NIGHT]: "0" };

const automotive: BootedDevice = {
  name: "AAOS",
  platform: "android",
  deviceId: "emulator-5554",
};

/** What `ro.build.characteristics` and `ro.kernel.qemu` say; a booted device carries no form factor. */
function traitsOf(formFactor: "automotive" | null, isEmulator = true): DeviceTraits {
  return {
    read: () =>
      Promise.resolve({
        isEmulator,
        model: null,
        sdk: 34,
        abi: null,
        manufacturer: null,
        brand: null,
        skin: null,
        formFactor,
      }),
  };
}

function injectorFor(
  device: BootedDevice,
  key: "vehicle.motion" | "vehicle.nightMode",
  adb: VehicleAdb,
  traits: DeviceTraits = traitsOf("automotive"),
) {
  const injector = resolveVehicleStateInjector(device, key, {
    adbFactory: { create: () => adb },
    cache: new Map(),
    traits,
    timer: adb.timer,
  });
  if (!injector) {
    throw new Error("no injector");
  }
  return injector;
}

describe("vehicle state injectors (#14919)", () => {
  test("driving sets gear, speed and brake together and reports the driving state", async () => {
    const car = vehicleAdb({ ...PARKED });
    const out = await injectorFor(automotive, "vehicle.motion", car.adb).apply("driving");
    expect(out.status).toBe("applied");
    expect(car.props).toMatchObject({ [GEAR]: "8", [SPEED]: "10.0", [BRAKE]: "0" });
    expect(out.detail).toContain("Current Driving State: 2");
    expect(car.log).toContain(
      `shell cmd car_service inject-continuous-events ${SPEED} 10.0 -s 10 -d 5`,
    );
  });

  test("re-applying the same value is unchanged and writes nothing", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.motion", car.adb);
    await injector.apply("driving");
    const before = car.log.filter((c) => c.includes("inject-vhal-event")).length;
    const again = await injector.apply("driving");
    expect(again.status).toBe("unchanged");
    expect(car.log.filter((c) => c.includes("inject-vhal-event")).length).toBe(before);
  });

  test("release restores the values read before the first change, across value switches", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.motion", car.adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ vehicle: { motion: "driving" } });
    await controller.apply({ vehicle: { motion: "parked" } });
    await controller.apply({ vehicle: { motion: "driving" } });
    expect(controller.activeKeys()).toEqual(["vehicle.motion"]);
    const report = await controller.restore();
    expect(report.verifiedClean).toBe(true);
    expect(car.props).toMatchObject({ [GEAR]: "4", [SPEED]: "0.0", [BRAKE]: "1" });
  });

  test("unset clears the key and restores sensor control", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.nightMode", car.adb);
    const controller = new DeviceConditionController(() => injector);
    const applied = await controller.apply({ vehicle: { nightMode: "on" } });
    expect(applied.changes[0].status).toBe("applied");
    expect(car.props[NIGHT]).toBe("1");
    const cleared = await controller.apply({ vehicle: { nightMode: "unset" } });
    expect(cleared.changes[0].status).toBe("cleared");
    expect(car.props[NIGHT]).toBe("0");
    expect(car.log).toContain("shell cmd car_service day-night-mode sensor");
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("restore clears night mode when sensor control differs from the baseline", async () => {
    const car = vehicleAdb({ ...PARKED }, { sensorNight: true });
    const injector = injectorFor(automotive, "vehicle.nightMode", car.adb);
    const controller = new DeviceConditionController(() => injector);
    const applied = await controller.apply({ vehicle: { nightMode: "on" } });
    expect(applied.changes[0].status).toBe("applied");
    expect(controller.hasActiveConditions()).toBe(true);

    const report = await controller.restore();
    expect(car.log).toContain("shell cmd car_service day-night-mode sensor");
    expect(car.props[NIGHT]).toBe("1");
    expect(report.verifiedClean).toBe(true);
    expect(report.failures).toEqual([]);
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("a target equal to the current state registers nothing to restore", async () => {
    const car = vehicleAdb({ ...PARKED });
    const out = await injectorFor(automotive, "vehicle.nightMode", car.adb).apply("off");
    expect(out.status).toBe("unchanged");
    expect(out.reset).toBeUndefined();
  });

  test("night on verifies the real UI state instead of the unchanged VHAL store", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.nightMode", car.adb);
    const out = await injector.apply("on");
    expect(out.status).toBe("applied");
    expect(out.detail).toContain("Night mode: yes");
    expect(car.log).toContain("shell cmd car_service day-night-mode night");
    expect(car.log.some((command) => command.includes("get-property-value"))).toBe(false);
    expect(await injector.isClean()).toBe(false);
    await out.reset?.();
    expect(await injector.isClean()).toBe(true);
    car.props[NIGHT] = "1";
    expect(await injector.isClean()).toBe(true);
  });

  test("night on that leaves day mode throws a typed failure and retains cleanup", async () => {
    const car = vehicleAdb({ ...PARKED }, { nightIgnored: true });
    const injector = injectorFor(automotive, "vehicle.nightMode", car.adb);
    await expect(injector.apply("on")).rejects.toBeInstanceOf(ActionableError);
    const controller = new DeviceConditionController(() => injector);
    const out = await controller.apply({ vehicle: { nightMode: "on" } });
    expect(out.success).toBe(false);
    expect(out.changes[0]).toMatchObject({
      status: "unsupported",
      detail: expect.stringContaining("Night mode: no"),
    });
    expect(controller.hasActiveConditions()).toBe(true);
    expect((await controller.restore()).verifiedClean).toBe(true);
  });

  test("night off uses day mode and verifies no", async () => {
    const car = vehicleAdb({ ...PARKED, [NIGHT]: "1" });
    const out = await injectorFor(automotive, "vehicle.nightMode", car.adb).apply("off");
    expect(out.status).toBe("applied");
    expect(out.detail).toContain("Night mode: no");
    expect(car.log).toContain("shell cmd car_service day-night-mode day");
  });

  test("driving waits for MOVING and requires it to stay stable", async () => {
    const car = vehicleAdb(
      { ...PARKED },
      {
        drivingStates: [
          "Current Driving State: 0",
          "Current Driving State: 1",
          "Current Driving State: 2",
        ],
      },
    );
    const out = await injectorFor(automotive, "vehicle.motion", car.adb).apply("driving");
    expect(out.status).toBe("applied");
    expect(car.timer.getSleepHistory()).toEqual([500, 500, 500, 500, 500]);
    expect(out.detail).toBe("vehicle motion driving (Current Driving State: 2)");
  });

  test("a transient MOVING followed by IDLING is a typed failure, never applied", async () => {
    const car = vehicleAdb(
      { ...PARKED },
      {
        drivingStates: [
          "Current Driving State: 0",
          "Current Driving State: 2",
          "Current Driving State: 2",
          "Current Driving State: 1",
        ],
      },
    );
    const controller = new DeviceConditionController(() =>
      injectorFor(automotive, "vehicle.motion", car.adb),
    );
    const out = await controller.apply({ vehicle: { motion: "driving" } });
    expect(out.success).toBe(false);
    expect(out.changes[0]).toMatchObject({
      status: "unsupported",
      detail: expect.stringContaining("Current Driving State: 1"),
    });
    expect(controller.hasActiveConditions()).toBe(true);
    expect(car.timer.now()).toBe(5_000);
  });

  test("parked reaches state 0 and is applied", async () => {
    const car = vehicleAdb({ ...PARKED, [GEAR]: "8", [SPEED]: "10.0", [BRAKE]: "0" });
    const out = await injectorFor(automotive, "vehicle.motion", car.adb).apply("parked");
    expect(out.status).toBe("applied");
    expect(out.detail).toBe("vehicle motion parked (Current Driving State: 0)");
  });

  test("a clients header without a current state fails closed with a typed error", async () => {
    const car = vehicleAdb({ ...PARKED }, { drivingStates: ["Driving State Clients:\n  state 2"] });
    await expect(
      injectorFor(automotive, "vehicle.motion", car.adb).apply("driving"),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(car.timer.now()).toBe(5_000);
  });

  test("renewal holds driving beyond one burst and reset waits for it to lapse", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.motion", car.adb);
    const out = await injector.apply("driving");
    car.timer.advanceTime(2_000);
    // An apply shares the serializer with the queued renewal, so it drains that renewal first.
    await injector.apply("driving");
    expect(car.log.filter((command) => command.includes("inject-continuous-events"))).toHaveLength(
      2,
    );
    await out.reset?.();
    expect(car.timer.now()).toBe(14_100);
    expect(car.props[SPEED]).toBe("0.0");
    expect(await injector.isClean()).toBe(true);
    const before = car.log.length;
    car.timer.advanceTime(100_000);
    await Promise.resolve();
    expect(car.log).toHaveLength(before);
  });

  test("renewal survives the applying request's cancellation context", async () => {
    const car = vehicleAdb({ ...PARKED });
    const real = car.adb.execute.bind(car.adb);
    let renewalSignal: AbortSignal | undefined;
    car.adb.execute = (args, options) => {
      if (args.includes("inject-continuous-events") && car.timer.now() >= 4_000) {
        renewalSignal = getAbortSignal();
      }
      return real(args, options);
    };
    const injector = injectorFor(automotive, "vehicle.motion", car.adb);
    const controller = new AbortController();
    const out = await runWithAbortSignal(controller.signal, () => injector.apply("driving"));
    controller.abort();
    car.timer.advanceTime(2_000);
    await injector.apply("driving");
    expect(renewalSignal).toBeUndefined();
    await out.reset?.();
  });

  test("a phone is unsupported and issues no car service command", async () => {
    const car = vehicleAdb({ ...PARKED });
    await expect(
      injectorFor(automotive, "vehicle.motion", car.adb, traitsOf(null)).apply("driving"),
    ).rejects.toThrow(/unsupported.*not one/);
    expect(car.log).toEqual([]);
  });

  test("a physical head unit is unsupported", async () => {
    const car = vehicleAdb({ ...PARKED });
    const physical: BootedDevice = { ...automotive, deviceId: "R58M123ABC" };
    const traits = traitsOf("automotive", false);
    await expect(
      injectorFor(physical, "vehicle.motion", car.adb, traits).apply("parked"),
    ).rejects.toThrow(/emulators only/);
    expect(car.log).toEqual([]);
  });

  test("an unreadable property fails closed before any write", async () => {
    const car = vehicleAdb({ ...PARKED });
    const log: string[] = [];
    car.adb.execute = (args) => {
      log.push(args.join(" "));
      return Promise.resolve(execResult("no value"));
    };
    await expect(
      injectorFor(automotive, "vehicle.motion", car.adb).apply("driving"),
    ).rejects.toThrow(/could not read vehicle property/);
  });

  test("a rejected inject surfaces as unsupported and owes the restore", async () => {
    const car = vehicleAdb({ ...PARKED }, { injectFails: true });
    const controller = new DeviceConditionController(() =>
      injectorFor(automotive, "vehicle.motion", car.adb),
    );
    const result = await controller.apply({ vehicle: { motion: "driving" } });
    expect(result.changes[0].status).toBe("unsupported");
    // Nothing was written, so no restore is owed and release reads clean.
    expect(controller.hasActiveConditions()).toBe(false);
    expect((await controller.restore()).verifiedClean).toBe(true);
  });

  test.each([
    ["get-property-value", "error"],
    ["get-property-value", "stdout"],
    ["get-property-value", "throw"],
    ["get-property-value", "wrapped"],
    ["get-property-value", "stdout-error"],
    ["get-property-value", "stderr-error"],
    ["inject-vhal-event", "error"],
    ["inject-vhal-event", "stdout"],
    ["inject-vhal-event", "throw"],
    ["inject-vhal-event", "wrapped"],
    ["inject-vhal-event", "stdout-error"],
    ["inject-vhal-event", "stderr-error"],
    ["day-night-mode", "wrapped"],
    ["day-night-mode", "stdout-error"],
    ["day-night-mode", "stderr-error"],
  ])("a user-build %s refusal via %s is unsupported before any write", async (command, form) => {
    const car = vehicleAdb({ ...PARKED });
    const refusal = new FakeAdbExecutor();
    const message = `java.lang.SecurityException: The command '${command}' requires non-user build`;
    if (form === "wrapped") {
      const args = ["shell", "cmd", "car_service", command];
      const raw = Object.assign(
        new Error(`Command failed: adb ${args.join(" ")}\n${userBuildRefusal}`),
        {
          code: 255,
          stdout: userBuildRefusal,
          stderr: "",
        },
      );
      const wrapped = wrapCommandError(raw, { command: "adb", args, stdout: userBuildRefusal });
      expect(errorMessage(wrapped)).not.toContain("requires non-user build");
      refusal.setCommandError(command, wrapped);
    } else if (form === "stdout-error" || form === "stderr-error") {
      refusal.setCommandResponse(command, {
        ...execResult(form === "stdout-error" ? userBuildRefusal : ""),
        stderr: form === "stderr-error" ? userBuildRefusal : "",
        error: "Command failed (exit 255)",
      });
    } else if (form === "throw") {
      refusal.setCommandError(command, new Error(message));
    } else {
      refusal.setCommandResponse(command, {
        ...execResult(form === "stdout" ? message : ""),
        ...(form === "error" ? { error: `Command failed (exit 255): ${message}` } : {}),
      });
    }
    const real = car.adb.execute.bind(car.adb);
    car.adb.execute = (args, options) =>
      args.includes(command) ? refusal.execute(args, options) : real(args, options);
    const nightMode = command === "day-night-mode";
    const feature = nightMode ? "vehicle.nightMode" : "vehicle.motion";
    const injector = injectorFor(automotive, feature, car.adb);
    const controller = new DeviceConditionController(() => injector);
    const result = await controller.apply({
      vehicle: nightMode ? { nightMode: "on" } : { motion: "driving" },
    });
    expect(result.changes[0].status).toBe("unsupported");
    expect(result.changes[0].detail).toContain(
      "unsupported on this image: this AAOS image is a user build",
    );
    expect(result.changes[0].detail).toContain(`${feature} needs a userdebug/eng image`);
    expect(result.changes[0].detail).toContain("`android-automotive` API 34 ext9");
    expect(car.props).toEqual(PARKED);
    expect(car.log.some((entry) => entry.includes("inject-"))).toBe(false);
    expect(controller.hasActiveConditions()).toBe(false);
    expect((await controller.restore()).verifiedClean).toBe(true);
  });

  test("night mode still applies and resets when user-build motion commands are refused", async () => {
    const car = vehicleAdb({ ...PARKED });
    const real = car.adb.execute.bind(car.adb);
    car.adb.execute = (args, options) => {
      if (args.includes("get-property-value") || args.includes("inject-vhal-event")) {
        return Promise.resolve({
          ...execResult(""),
          error: "java.lang.SecurityException: The command requires non-user build",
        });
      }
      return real(args, options);
    };
    const injector = injectorFor(automotive, "vehicle.nightMode", car.adb);
    const result = await injector.apply("on");
    expect(result.status).toBe("applied");
    expect(car.props[NIGHT]).toBe("1");
    await result.reset?.();
    expect(car.props[NIGHT]).toBe("0");
    expect(await injector.isClean()).toBe(true);
  });

  test("unrelated car service errors pass through unchanged", async () => {
    const adb = new FakeAdbExecutor();
    const failure = new ActionableError("device disconnected");
    adb.setCommandError("get-property-value", failure);
    await expect(createVehiclePropertyAccess(adb).read(GEAR)).rejects.toBe(failure);
  });

  test("a failure after a write owes the restore, which puts the baseline back", async () => {
    const car = vehicleAdb({ ...PARKED });
    const real = car.adb.execute.bind(car.adb);
    let injects = 0;
    car.adb.execute = (args) => {
      const command = args.join(" ");
      if (command.includes("inject-vhal-event") && ++injects === 2) {
        return Promise.resolve(execResult("Exception: boom"));
      }
      return real(args);
    };
    const controller = new DeviceConditionController(() =>
      injectorFor(automotive, "vehicle.motion", car.adb),
    );
    const result = await controller.apply({ vehicle: { motion: "driving" } });
    expect(result.changes[0].status).toBe("unsupported");
    expect(controller.hasActiveConditions()).toBe(true);
    car.adb.execute = real;
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(car.props).toMatchObject({ [GEAR]: "4", [SPEED]: "0.0", [BRAKE]: "1" });
  });

  test("a second controller on the same injector owes the restore too", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.motion", car.adb);
    const sessionless = new DeviceConditionController(() => injector);
    const session = new DeviceConditionController(() => injector);
    await sessionless.apply({ vehicle: { motion: "driving" } });
    await session.apply({ vehicle: { motion: "driving" } });
    expect(session.hasActiveConditions()).toBe(true);
    expect((await session.restore()).verifiedClean).toBe(true);
    expect(car.props[GEAR]).toBe("4");
  });

  test("an invalid value is rejected", async () => {
    const car = vehicleAdb({ ...PARKED });
    await expect(
      injectorFor(automotive, "vehicle.motion", car.adb).apply("flying"),
    ).rejects.toThrow(/Expected one of: parked, driving/);
  });

  test("only vehicle keys on Android resolve", () => {
    const { adb } = vehicleAdb({});
    const deps = { adbFactory: { create: () => adb }, cache: new Map() };
    expect(resolveVehicleStateInjector(automotive, "faults.battery", deps)).toBeUndefined();
    expect(
      resolveVehicleStateInjector({ ...automotive, platform: "ios" }, "vehicle.motion", deps),
    ).toBeUndefined();
  });

  test("iOS refuses vehicle keys by name", async () => {
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID" };
    await expect(
      resolveIosRefusalInjector(ios, "vehicle.motion")?.apply("driving"),
    ).rejects.toThrow(/unsupported on iOS Simulator/);
  });

  test("the request splits into vehicle changes", () => {
    expect(deviceConditionChanges({ vehicle: { nightMode: "on", motion: "unset" } })).toEqual([
      { key: "vehicle.motion", value: "unset" },
      { key: "vehicle.nightMode", value: "on" },
    ]);
  });

  test("parses the first numeric value of a read", () => {
    expect(parsePropertyValue("Value[floatValues: [3.5]]")).toBe("3.5");
    expect(parsePropertyValue("nothing here")).toBeUndefined();
  });
});
