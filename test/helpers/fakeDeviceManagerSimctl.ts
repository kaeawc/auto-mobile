import type { DeviceManagerSimCtl } from "../../src/devices/deviceUtils";

type Operation = Exclude<keyof DeviceManagerSimCtl, "getSimulatorListingChecked">;

function unstubbed(name: Operation): never {
  throw new TypeError(`fakeDeviceManagerSimctl.${name} is not stubbed`);
}

/**
 * Build the simctl handle a MultiPlatformDeviceManager test needs from only the operations it
 * exercises. Required operations left out throw a TypeError when called, like the absent methods of
 * the partial objects this replaces. The optional `getSimulatorListingChecked` is never filled in:
 * the manager branches on its presence.
 */
export function fakeDeviceManagerSimctl(
  overrides: Partial<DeviceManagerSimCtl> = {},
): DeviceManagerSimCtl {
  const notStubbed = {
    isAvailable: () => unstubbed("isAvailable"),
    listSimulatorImages: () => unstubbed("listSimulatorImages"),
    getBootedSimulators: () => unstubbed("getBootedSimulators"),
    getBootedSimulatorsChecked: () => unstubbed("getBootedSimulatorsChecked"),
    startSimulator: () => unstubbed("startSimulator"),
    deleteSimulator: () => unstubbed("deleteSimulator"),
    killSimulator: () => unstubbed("killSimulator"),
    waitForSimulatorReady: () => unstubbed("waitForSimulatorReady"),
  } satisfies Pick<DeviceManagerSimCtl, Operation>;
  return { ...notStubbed, ...overrides };
}
