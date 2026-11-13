import { describe, expect, test } from "bun:test";
import { resolveVehicleStateInjector } from "../../../src/features/deviceCondition/vehicleStateInjectors";
import type { HeadUnitConsoleLookup } from "../../../src/features/deviceCondition/headUnitVehicleInjector";
import type { BootedDevice } from "../../../src/models";
import type { DeviceTraits } from "../../../src/utils/android-cmdline-tools/deviceTraits";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSession } from "../../fakes/FakeAndroidAutoProjection";
import { FakeTimer } from "../../fakes/FakeTimer";

const phone: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };

const PHONE_TRAITS: DeviceTraits = {
  read: async () => ({
    isEmulator: true,
    model: null,
    sdk: 36,
    abi: null,
    manufacturer: null,
    brand: null,
    skin: null,
    formFactor: null,
  }),
};

/** A phone whose DHU is `session`, as instance `instance`; adb must not be used. */
function setup() {
  const adb = new FakeAdbExecutor();
  const adbCalls: string[] = [];
  adb.execute = async (args) => {
    adbCalls.push(args.join(" "));
    throw new Error("the head unit path must not use adb");
  };
  const dhu = { session: new FakeSession() as FakeSession | undefined, instance: "dhu-1" };
  const lookup: HeadUnitConsoleLookup = (deviceId) => {
    const session = dhu.session;
    if (deviceId !== phone.deviceId || !session) {
      return undefined;
    }
    return {
      sendCommand: (command) => session.sendCommand(command),
      isRunning: () => session.isRunning(),
      panel: { instance: dhu.instance },
    };
  };
  const injector = (key: "vehicle.motion" | "vehicle.nightMode") => {
    const resolved = resolveVehicleStateInjector(phone, key, {
      adbFactory: { create: () => adb },
      cache: new Map(),
      traits: PHONE_TRAITS,
      timer: new FakeTimer(),
      headUnit: lookup,
    });
    if (!resolved) {
      throw new Error("no injector");
    }
    return resolved;
  };
  return { dhu, adbCalls, injector };
}

describe("deviceCondition.vehicle on a projecting phone's head unit (#17842)", () => {
  test("nightMode on sends night, and reset sends day", async () => {
    const { dhu, adbCalls, injector } = setup();
    const nightMode = injector("vehicle.nightMode");
    const outcome = await nightMode.apply("on");
    expect(outcome.status).toBe("applied");
    expect(await nightMode.isClean()).toBe(false);
    await outcome.reset?.();
    expect(dhu.session?.commands).toEqual(["night", "day"]);
    expect(await nightMode.isClean()).toBe(true);
    expect(adbCalls).toEqual([]);
  });

  test("motion driving restricts all, parked restricts none", async () => {
    const { dhu, injector } = setup();
    const motion = injector("vehicle.motion");
    await motion.apply("driving");
    const outcome = await motion.apply("parked");
    await outcome.reset?.();
    expect(dhu.session?.commands).toEqual(["restrict all", "restrict none", "restrict none"]);
  });

  test("a repeat on the same DHU is unchanged; a restarted DHU is sent it again", async () => {
    const { dhu, injector } = setup();
    const nightMode = injector("vehicle.nightMode");
    await nightMode.apply("on");
    expect((await nightMode.apply("on")).status).toBe("unchanged");
    dhu.session = new FakeSession();
    dhu.instance = "dhu-2";
    expect((await nightMode.apply("on")).status).toBe("applied");
    expect(dhu.session.commands).toEqual(["night"]);
  });

  test("reset after the DHU exited sends nothing and leaves the key clean", async () => {
    const { dhu, injector } = setup();
    const nightMode = injector("vehicle.nightMode");
    const outcome = await nightMode.apply("on");
    const exited = dhu.session;
    dhu.session = undefined;
    await outcome.reset?.();
    expect(exited?.commands).toEqual(["night"]);
    expect(await nightMode.isClean()).toBe(true);
  });

  test("without a running DHU a phone is still refused, naming both targets", async () => {
    const { dhu, injector } = setup();
    dhu.session = undefined;
    await expect(injector("vehicle.motion").apply("driving")).rejects.toThrow(
      /unsupported.*Desktop Head Unit.*neither/,
    );
  });

  test("a value the key does not take is refused before any command", async () => {
    const { dhu, injector } = setup();
    await expect(injector("vehicle.nightMode").apply("dusk")).rejects.toThrow("Invalid");
    expect(dhu.session?.commands).toEqual([]);
  });
});
