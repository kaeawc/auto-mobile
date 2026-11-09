import type { BootedDevice, OpenURLResult } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import type { ActionCall } from "../action/ActionCall";

/** The one simctl call an Apple TV link open makes. */
export type TvosOpenUrlSimctl = Pick<SimCtlClient, "executeCommandArgs">;

/**
 * openLink on an Apple TV simulator (#16724): `simctl openurl <udid> <url>`. tvOS has no Safari,
 * so the system hands a custom-scheme link to the app that declares the scheme in
 * `CFBundleURLTypes`; simctl fails when no installed app handles it. No CtrlProxy or observation
 * step runs: the caller observes afterwards.
 */
export class TvosOpenURL {
  private simctl: TvosOpenUrlSimctl | null;

  constructor(
    private readonly device: BootedDevice,
    simctl: TvosOpenUrlSimctl | null = null,
  ) {
    this.simctl = simctl;
  }

  async execute(url: string, call: ActionCall = {}): Promise<OpenURLResult> {
    const { signal } = call;
    throwIfAborted(signal);
    const trimmed = url?.trim() ?? "";
    if (!trimmed) {
      return { success: false, url: url ?? "", error: "Invalid URL provided" };
    }
    if (trimmed.startsWith("package:")) {
      return {
        success: false,
        url: trimmed,
        error: "package: URLs are Android-only; use launchApp to start an Apple TV app.",
      };
    }
    this.simctl ??= new SimCtlClient(this.device);
    try {
      // argv form so the URL reaches simctl byte-for-byte (#4213).
      await awaitWhileRequestIsLive(
        this.simctl.executeCommandArgs(
          ["openurl", this.device.deviceId, trimmed],
          undefined,
          signal,
        ),
        signal,
      );
      throwIfAborted(signal);
      return { success: true, url: trimmed };
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[TvosOpenURL] simctl openurl failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        url: trimmed,
        error: toActionableError(
          error,
          `Failed to open URL on Apple TV simulator ${this.device.deviceId}; check that an installed app declares the URL scheme`,
        ).message,
      };
    }
  }
}

/** Options openLink accepts that an Apple TV cannot honour, refused by name before any open. */
export function assertTvosOpenLinkArgs(args: {
  waitFor?: unknown;
  settled?: unknown;
  acceptOpenAlert?: boolean;
  chooserAppPackage?: string;
}): void {
  const refused = [
    args.waitFor !== undefined ? "waitFor" : undefined,
    args.settled !== undefined ? "settled" : undefined,
    args.acceptOpenAlert !== undefined ? "acceptOpenAlert" : undefined,
    args.chooserAppPackage !== undefined ? "chooserAppPackage" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (refused.length > 0) {
    throw new ActionableError(
      `openLink does not support ${refused.join(", ")} on tvOS. Open the link without ` +
        "them, then call observe and navigate with pressButton.",
    );
  }
}
