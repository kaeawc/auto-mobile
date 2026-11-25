import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../describeUnknownError";
import { SimCtlClient } from "../ios-cmdline-tools/SimCtlClient";
import {
  iosVersionFromSimctlListDevices,
  parseIosMajorVersion,
} from "../ios-cmdline-tools/iosVersion";
import { logger } from "../logger";

/** The first iOS major whose Simulator has no CarPlay (Xcode 27 dropped it). */
const FIRST_UNSUPPORTED_IOS_MAJOR = 27;
const SIMCTL_LIST_TIMEOUT_MS = 10000;

/** Reads a simulator's dotted iOS runtime version, or `undefined` when it cannot tell. */
export interface CarPlayRuntimeReader {
  runtimeVersion(udid: string, signal?: AbortSignal): Promise<string | undefined>;
}

export class DefaultCarPlayRuntimeReader implements CarPlayRuntimeReader {
  /** Built on first use, so importing a CarPlay entry point creates no simctl client. */
  constructor(
    private readonly simctl: () => Pick<SimCtlClient, "executeCommandArgs"> = () =>
      new SimCtlClient(),
  ) {}

  async runtimeVersion(udid: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const result = await this.simctl().executeCommandArgs(
        ["list", "--json", "devices", udid],
        SIMCTL_LIST_TIMEOUT_MS,
        signal,
      );
      return iosVersionFromSimctlListDevices(result.stdout, udid);
    } catch (error) {
      signal?.throwIfAborted();
      // An unknown runtime skips only this early check; the CarPlay helpers still refuse iOS 27+.
      logger.warn(`[carPlay] simctl list devices ${udid} failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }
}

/**
 * Refuses an iOS 27+ simulator with `[unsupported-runtime]` before any CarPlay helper or probe
 * runs (#19185), so a missing helper is never reported for a runtime that cannot show CarPlay.
 * An unknown runtime passes; the helpers check it again.
 */
export async function requireCarPlayRuntime(
  udid: string,
  reader: CarPlayRuntimeReader,
  signal?: AbortSignal,
): Promise<void> {
  const version = await reader.runtimeVersion(udid, signal);
  const major = parseIosMajorVersion(version);
  if (major !== null && major >= FIRST_UNSUPPORTED_IOS_MAJOR) {
    throw new ActionableError(
      `[unsupported-runtime] Headless CarPlay needs an iOS 26.x runtime (found ${version}). Apple does not support CarPlay on the iOS 27 Simulator; use an Xcode 26.x iOS 26 simulator.`,
    );
  }
}
