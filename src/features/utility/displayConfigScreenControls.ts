import type {
  DisplayConfigResult,
  DisplayConfigSupport,
  SetDisplayConfigInput,
} from "./DisplayConfig";
import { mergeGeometryChange } from "./displayConfigInput";
import {
  DYNAMIC_ISLAND_UNSUPPORTED_ERROR,
  SCREEN_CONTROL_FIELDS,
  type IosSimulatorScreenControls,
  type IosSimulatorScreenValues,
} from "./IosSimulatorScreenControls";

export const SCREEN_CONTROLS_SIMULATOR_ONLY_ERROR =
  "dynamicIsland and backlight are iOS Simulator only: they use the Simulator's SpringBoard " +
  "defaults and CoreSimulator, which Android and physical iOS devices do not have.";

/**
 * iOS Simulator Dynamic Island and backlight (#19018), applied after the other fields of the
 * request (or a reset) through `setRest`, and merged into one result.
 */
export async function setWithScreenControls(
  input: SetDisplayConfigInput,
  setRest: (rest: SetDisplayConfigInput) => Promise<DisplayConfigResult>,
  controls: IosSimulatorScreenControls,
  identity: { deviceId: string; platform: "android" | "ios"; supported: DisplayConfigSupport },
): Promise<DisplayConfigResult> {
  const island = await controls.supportsDynamicIsland();
  const supported = { ...identity.supported, dynamicIsland: island };
  if (!island && input.dynamicIsland !== undefined) {
    // Refused before any field of the request changes the device.
    return { success: false, ...identity, supported, error: DYNAMIC_ISLAND_UNSUPPORTED_ERROR };
  }
  const rest: SetDisplayConfigInput = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        value !== undefined && !(SCREEN_CONTROL_FIELDS as readonly string[]).includes(key),
    ),
  );
  const display = Object.keys(rest).length > 0 ? await setRest(rest) : undefined;
  if (display && !display.success && display.previous === undefined) {
    return display;
  }
  const screen: IosSimulatorScreenValues = {
    ...(input.dynamicIsland !== undefined ? { dynamicIsland: input.dynamicIsland } : {}),
    ...(input.backlight !== undefined ? { backlight: input.backlight } : {}),
  };
  const merged = mergeGeometryChange(
    display,
    await controls.set(screen, input.reset === true),
    identity,
  );
  return { ...merged, supported: { ...merged.supported, dynamicIsland: island } };
}
