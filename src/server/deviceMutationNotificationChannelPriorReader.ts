import type { BootedDevice } from "../models";
import {
  notificationChannelBroadcastCommand,
  notificationChannelBroadcastState,
  postedNotificationChannel,
  type PostedNotificationChannel,
} from "../daemon/sessionBroker/mutations/postedNotification";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

const UNOBSERVABLE: MutationValue = { state: "unobservable" };

/**
 * Priors for the notification-channel rows of an Android `postNotification` (#16510): whether the
 * app already had the channel, asked of the app's SDK receiver before the post creates it. Only an
 * `absent` prior lets reset delete the channel; an SDK without the channel actions, a failed read
 * and every other intent are `unobservable`.
 */
export class NotificationChannelMutationPriorReader implements MutationPriorReader {
  constructor(private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const priors: MutationValue[] = [];
    for (const entry of mutations) {
      signal?.throwIfAborted();
      const channel =
        device.platform === "android" && entry.kind === "notification"
          ? postedNotificationChannel(entry.key)
          : undefined;
      priors.push(
        channel === undefined ? UNOBSERVABLE : await this.readChannel(device, channel, signal),
      );
      // A read that failed because the request was cancelled is not an unobservable prior.
      signal?.throwIfAborted();
    }
    return priors;
  }

  private async readChannel(
    device: BootedDevice,
    channel: PostedNotificationChannel,
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    try {
      const result = await this.adbFactory
        .create(device)
        .executeCommand(notificationChannelBroadcastCommand(channel, "query"), {
          noRetry: true,
          signal,
        });
      const state = result.stderr?.trim()
        ? undefined
        : notificationChannelBroadcastState(result.stdout);
      if (state === undefined) {
        logger.warn(
          `notification channel ${channel.channelId} prior for ${channel.appId} is unreadable; the SDK may predate the channel actions`,
        );
        return UNOBSERVABLE;
      }
      return state === "absent" ? { state: "absent" } : { state: "present", value: true };
    } catch (error) {
      logger.warn(`notification channel prior read failed: ${errorMessage(error)}`, error);
      return UNOBSERVABLE;
    }
  }
}
