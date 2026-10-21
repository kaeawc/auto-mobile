import type { DeepLinkResult } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { throwIfAborted } from "../../../utils/toolUtils";
import type { AppLinksTarget } from "./AdbAppLinksDevice";
import { APP_LINKS_MIN_API_LEVEL, toAppLinkDomainStates } from "./appLinksOutput";

export type AppLinksStatusFields = Pick<
  DeepLinkResult,
  "appLinks" | "appLinksUserId" | "appLinkHandlingAllowed" | "appLinksUnavailable"
>;

/** Reads the App Links section `getDeepLinks` adds to its Android result (#14110). */
export interface AppLinksStatusReader {
  read(appId: string, signal?: AbortSignal): Promise<AppLinksStatusFields>;
}

/**
 * {@link AppLinksStatusReader} for one Android device. Never fails the
 * surrounding read: a pre-Android 12 device or an unreadable state yields
 * `appLinksUnavailable` with the reason instead of `appLinks`.
 */
export class DeviceAppLinksStatusReader implements AppLinksStatusReader {
  constructor(private readonly target: AppLinksTarget) {}

  async read(appId: string, signal?: AbortSignal): Promise<AppLinksStatusFields> {
    try {
      const apiLevel = await this.target.apiLevel(signal);
      throwIfAborted(signal);
      if (apiLevel !== null && apiLevel < APP_LINKS_MIN_API_LEVEL) {
        return {
          appLinksUnavailable: `App Links verification state needs Android 12 (API ${APP_LINKS_MIN_API_LEVEL}) or newer; this device runs API ${apiLevel}.`,
        };
      }
      const userId = await this.target.currentUserId(signal);
      const read = await this.target.appLinks.read(appId, userId, { signal });
      throwIfAborted(signal);
      if (!read.found && read.kind === "noState") {
        // The package is installed (dumpsys found it) but pm lists no web domains for it.
        return { appLinks: [], appLinksUserId: userId };
      }
      if (!read.found) {
        return { appLinksUnavailable: read.reason };
      }
      const handling = read.snapshot.user?.linkHandlingAllowed;
      return {
        appLinks: toAppLinkDomainStates(read.snapshot),
        appLinksUserId: userId,
        ...(handling === undefined ? {} : { appLinkHandlingAllowed: handling }),
      };
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[GetDeepLinks] Failed to read App Links state for ${appId}: ${errorMessage(error)}`,
        error,
      );
      return { appLinksUnavailable: `Failed to read App Links state: ${errorMessage(error)}` };
    }
  }
}
