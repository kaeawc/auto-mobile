import type { DeviceManagerSimCtl } from "../../src/devices/deviceUtils";

/** The stubs a test supplies; each is checked against the real simctl signature. */
type Overrides = Partial<Omit<DeviceManagerSimCtl, "getSimulatorListingChecked">>;

/** A required operation the test left out: it throws when called, like an absent method. */
const unstubbed = (name: string) => (): never => {
  throw new TypeError(`fakeDeviceManagerSimctl.${name} is not stubbed`);
};

/**
 * Build the simctl handle a MultiPlatformDeviceManager test needs from only the operations it
 * exercises. Required operations left out throw a TypeError when called, like the absent methods of
 * the partial objects this replaces. The optional `getSimulatorListingChecked` is never filled in:
 * the manager branches on its presence.
 */
export function fakeDeviceManagerSimctl(overrides: Overrides = {}): DeviceManagerSimCtl {
  return {
    isAvailable: unstubbed("isAvailable"),
    listSimulatorImages: unstubbed("listSimulatorImages"),
    getBootedSimulators: unstubbed("getBootedSimulators"),
    getBootedSimulatorsChecked: unstubbed("getBootedSimulatorsChecked"),
    startSimulator: unstubbed("startSimulator"),
    deleteSimulator: unstubbed("deleteSimulator"),
    killSimulator: unstubbed("killSimulator"),
    waitForSimulatorReady: unstubbed("waitForSimulatorReady"),
    ...overrides,
  };
}
