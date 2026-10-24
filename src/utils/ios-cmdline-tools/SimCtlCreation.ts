import type { SimCtlInventoryContext } from "./SimCtlInventory";
import { ActionableError, type ExecResult } from "../../models";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
/** Creation mutations share invalidation, without growing the inventory projection. */
export class SimCtlCreation {
  constructor(
    private readonly context: Pick<
      SimCtlInventoryContext,
      "executeCommandArgs" | "invalidateDeviceListCache"
    >,
    private readonly invalidateCatalog: () => void,
  ) {}
  async cloneSimulator(sourceUdid: string, name: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.context.executeCommandArgs(
        ["clone", sourceUdid, name],
        undefined,
        signal,
      );
      const udid = result.stdout.trim();
      if (!udid) {
        throw new ActionableError(`Failed to clone iOS simulator ${name}: empty UDID`);
      }
      return udid;
    } finally {
      this.context.invalidateDeviceListCache();
    }
  }

  async createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string> {
    logger.debug(`Creating iOS simulator: ${name} (${deviceType}, ${runtime})`);
    let result: ExecResult;
    try {
      result = await this.context.executeCommandArgs(
        ["create", name, deviceType, runtime],
        undefined,
        signal,
      );
    } catch (error) {
      if (/invalid (?:runtime|device type)/i.test(errorMessage(error))) {
        this.invalidateCatalog();
      }
      logger.warn(`Failed to create iOS simulator ${name}: ${errorMessage(error)}`, error);
      throw error;
    } finally {
      // A freshly created simulator must be visible to the very next
      // listSimulatorImages() call, otherwise the provisioning path boots off a
      // snapshot that predates the device it just created. A cancelled or
      // failed `simctl create` may still have created it, so invalidate on
      // every outcome (#11100).
      this.context.invalidateDeviceListCache();
    }
    const simulatorUdid = result.stdout.trim();

    if (!simulatorUdid) {
      throw new ActionableError(`Failed to create iOS simulator ${name}`);
    }

    logger.debug(`Created iOS simulator ${name} with UDID: ${simulatorUdid}`);
    return simulatorUdid;
  }
}
