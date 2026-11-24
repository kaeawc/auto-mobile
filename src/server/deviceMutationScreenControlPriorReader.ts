import type { BootedDevice } from "../models";
import {
  observableMutationValue as present,
  type MutationValue,
} from "../daemon/sessionBroker/mutations/types";
import { IosSimulatorScreenControls } from "../features/utility/IosSimulatorScreenControls";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

const UNOBSERVABLE: MutationValue = { state: "unobservable" };

type ScreenControlRead = Pick<
  IosSimulatorScreenControls,
  "readIslandSuppressedDefault" | "readBacklightOrThrow"
>;

const defaultControlsFor = (device: BootedDevice): ScreenControlRead =>
  new IosSimulatorScreenControls(device.deviceId, new SimCtlClient(device));

/**
 * Priors for the iOS Simulator `dynamicIsland` and `backlight` rows of displayConfig (#19018):
 * the SpringBoard island default (absent when unset) and whether the display was lit. A failed
 * read, a physical device and every other row are `unobservable`.
 */
export class ScreenControlMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly controlsFor: (device: BootedDevice) => ScreenControlRead = defaultControlsFor,
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const wanted = mutations.some(isScreenControlRow);
    const simulator =
      wanted &&
      device.platform === "ios" &&
      resolveIosDeviceKind({ deviceId: device.deviceId }) === "simulator";
    const controls = simulator ? this.controlsFor(device) : undefined;
    const priors: MutationValue[] = [];
    for (const entry of mutations) {
      signal?.throwIfAborted();
      priors.push(
        controls && isScreenControlRow(entry) ? await readPrior(controls, entry.key) : UNOBSERVABLE,
      );
      // A read that failed because the request was cancelled is not an unobservable prior.
      signal?.throwIfAborted();
    }
    return priors;
  }
}

function isScreenControlRow(entry: ToolMutation): boolean {
  return entry.kind === "device-setting" && ["dynamicIsland", "backlight"].includes(entry.key);
}

async function readPrior(controls: ScreenControlRead, key: string): Promise<MutationValue> {
  try {
    if (key === "backlight") {
      return present(await controls.readBacklightOrThrow());
    }
    const suppressed = await controls.readIslandSuppressedDefault();
    return suppressed === null ? { state: "absent" } : present(suppressed);
  } catch (error) {
    logger.warn(`iOS Simulator ${key} prior read failed: ${errorMessage(error)}`, error);
    return UNOBSERVABLE;
  }
}
