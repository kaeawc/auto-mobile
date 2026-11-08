import { assertTvosOpenLinkArgs, TvosOpenURL } from "../features/tvos/TvosOpenUrl";
import type { BootedDevice } from "../models";
import {
  createStructuredToolResponse,
  throwIfAborted,
  withIsErrorOnFailure,
} from "../utils/toolUtils";
import type { OpenLinkExecutor } from "./interactionTools/dependencies";
import type { OpenLinkArgs } from "./interactionToolTypes";
import type { ProgressCallback } from "./toolRegistry";

type OpenLinkHandler<Response> = (
  device: BootedDevice,
  args: OpenLinkArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => Promise<Response>;

/**
 * openLink on an Apple TV (#16724): a plain `simctl openurl`, with the options that need an
 * iOS alert, an Android chooser or an awaited observation refused by name. The caller observes
 * afterwards. Every other platform keeps `mobileHandler`.
 */
export function withTvosOpenLink<Response>(
  mobileHandler: OpenLinkHandler<Response>,
  deps: { openUrlFactory?: (device: BootedDevice) => OpenLinkExecutor } = {},
) {
  return async (
    device: BootedDevice,
    args: OpenLinkArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "tvos") {
      return mobileHandler(device, args, progress, signal);
    }
    throwIfAborted(signal);
    assertTvosOpenLinkArgs(args);
    const opener = deps.openUrlFactory?.(device) ?? new TvosOpenURL(device);
    const opened = await opener.execute(args.url, { signal });
    throwIfAborted(signal);
    const message = opened.success
      ? `Opened link ${args.url}`
      : `Failed to open ${args.url}: ${opened.error || "unknown error"}`;
    return withIsErrorOnFailure(
      createStructuredToolResponse({ message, ...opened }),
      opened.success,
    );
  };
}
