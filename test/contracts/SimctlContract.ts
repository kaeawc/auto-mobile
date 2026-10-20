import { describe, expect, test } from "bun:test";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
  SimCtlClient,
} from "../../src/utils/ios-cmdline-tools/SimCtlClient";

/** The `simctl list runtimes|devicetypes` surface the contract exercises. */
export type SimctlCatalog = Pick<
  SimCtlClient,
  "getRuntimes" | "getRuntimesChecked" | "getDeviceTypes" | "getDeviceTypesChecked"
>;

/**
 * The scenario driver each implementation supplies. The real SimCtlClient replays `simctl` stdout
 * through an injected exec seam; the fake is scripted directly. Scenarios only use this surface.
 */
export interface ScriptedSimctl {
  simctl: SimctlCatalog;
  /** `simctl list runtimes` reports exactly these runtimes. */
  scriptRuntimes(runtimes: AppleDeviceRuntime[]): void;
  /** `simctl list devicetypes` reports exactly these device types. */
  scriptDeviceTypes(types: AppleDeviceType[]): void;
  /** Both listings return stdout that is not the expected JSON document. */
  scriptMalformedOutput(): void;
  /** Both listings fail to run at all (no Xcode, CoreSimulator down). */
  scriptCommandFailure(error: Error): void;
}

/**
 * Captured `simctl list ... --json` fixtures (test/fixtures/ios-simctl) parsed into the shared
 * data the scenarios script. One runtime has `isAvailable` flipped to model an unavailable runtime
 * simctl lists but cannot boot.
 */
export interface SimctlContractData {
  runtimes: AppleDeviceRuntime[];
  deviceTypes: AppleDeviceType[];
}

/**
 * Shared behavioural contract for {@link SimCtl} listings (#11868): the scripted FakeSimctl and the
 * real SimCtlClient replaying captured simctl output agree on what each listing returns, how the
 * lenient and checked variants treat malformed output, and that a failed command surfaces.
 */
export function runSimctlContract(
  name: string,
  make: () => ScriptedSimctl,
  data: SimctlContractData,
): void {
  const ids = (list: Array<{ identifier: string }>): string[] =>
    list.map((entry) => entry.identifier);
  const unavailable: AppleDeviceRuntime = {
    ...data.runtimes[0],
    identifier: "com.apple.CoreSimulator.SimRuntime.iOS-0-0",
    isAvailable: false,
  };

  describe(`SimCtl contract: ${name}`, () => {
    test("getRuntimes returns the scripted runtimes in order", async () => {
      const scripted = make();
      scripted.scriptRuntimes(data.runtimes);
      expect(ids(await scripted.simctl.getRuntimes())).toEqual(ids(data.runtimes));
    });

    test("listings carry every field of the scripted entries, not only identifiers", async () => {
      const scripted = make();
      scripted.scriptRuntimes([...data.runtimes, unavailable]);
      scripted.scriptDeviceTypes(data.deviceTypes);
      expect(await scripted.simctl.getRuntimes()).toEqual(data.runtimes);
      expect(await scripted.simctl.getRuntimesChecked()).toEqual([...data.runtimes, unavailable]);
      expect(await scripted.simctl.getDeviceTypes()).toEqual(data.deviceTypes);
      expect(await scripted.simctl.getDeviceTypesChecked()).toEqual(data.deviceTypes);
    });

    test("getRuntimes drops unavailable runtimes but getRuntimesChecked keeps them", async () => {
      const scripted = make();
      scripted.scriptRuntimes([...data.runtimes, unavailable]);
      expect(ids(await scripted.simctl.getRuntimes())).toEqual(ids(data.runtimes));
      expect(ids(await scripted.simctl.getRuntimesChecked())).toEqual(
        ids([...data.runtimes, unavailable]),
      );
    });

    test("getDeviceTypes and getDeviceTypesChecked return the scripted device types", async () => {
      const scripted = make();
      scripted.scriptDeviceTypes(data.deviceTypes);
      expect(ids(await scripted.simctl.getDeviceTypes())).toEqual(ids(data.deviceTypes));
      expect(ids(await scripted.simctl.getDeviceTypesChecked())).toEqual(ids(data.deviceTypes));
    });

    test("an empty listing is empty for both variants", async () => {
      const scripted = make();
      scripted.scriptRuntimes([]);
      scripted.scriptDeviceTypes([]);
      expect(await scripted.simctl.getRuntimes()).toEqual([]);
      expect(await scripted.simctl.getRuntimesChecked()).toEqual([]);
      expect(await scripted.simctl.getDeviceTypes()).toEqual([]);
      expect(await scripted.simctl.getDeviceTypesChecked()).toEqual([]);
    });

    test("malformed output: lenient listings are empty, checked listings throw", async () => {
      const scripted = make();
      scripted.scriptMalformedOutput();
      expect(await scripted.simctl.getRuntimes()).toEqual([]);
      expect(await scripted.simctl.getDeviceTypes()).toEqual([]);
      await expect(scripted.simctl.getRuntimesChecked()).rejects.toThrow();
      await expect(scripted.simctl.getDeviceTypesChecked()).rejects.toThrow();
    });

    test("a failed command throws from every listing", async () => {
      const scripted = make();
      scripted.scriptCommandFailure(new Error("simctl exploded"));
      await expect(scripted.simctl.getRuntimes()).rejects.toThrow();
      await expect(scripted.simctl.getRuntimesChecked()).rejects.toThrow();
      await expect(scripted.simctl.getDeviceTypes()).rejects.toThrow();
      await expect(scripted.simctl.getDeviceTypesChecked()).rejects.toThrow();
    });
  });
}
