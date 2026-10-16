import type { DeviceManagerSimCtl } from "../../src/devices/deviceUtils";

type Operation = Exclude<keyof DeviceManagerSimCtl, "getSimulatorListingChecked">;

/** Stubs may be looser than the real signatures (fewer params, `null` for a process handle). */
type LooseOverrides = Partial<Record<keyof DeviceManagerSimCtl, (...args: never[]) => unknown>>;

/**
 * Build the simctl handle a MultiPlatformDeviceManager test needs from only the operations it
 * exercises. Required operations left out throw a TypeError when called, like the absent methods of
 * the partial objects this replaces. The optional `getSimulatorListingChecked` is never filled in:
 * the manager branches on its presence.
 */
export function fakeDeviceManagerSimctl(overrides: LooseOverrides = {}): DeviceManagerSimCtl {
  const operations: Operation[] = [
    "isAvailable",
    "listSimulatorImages",
    "getBootedSimulators",
    "getBootedSimulatorsChecked",
    "startSimulator",
    "deleteSimulator",
    "killSimulator",
    "waitForSimulatorReady",
  ];
  const notStubbed = Object.fromEntries(
    operations.map((name) => [
      name,
      () => {
        throw new TypeError(`fakeDeviceManagerSimctl.${name} is not stubbed`);
      },
    ]),
  ) as unknown as DeviceManagerSimCtl;
  return { ...notStubbed, ...overrides } as DeviceManagerSimCtl;
}
