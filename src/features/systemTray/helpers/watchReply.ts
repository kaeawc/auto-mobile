import { ActionableError, type Element, type ObserveResult } from "../../../models";
import {
  buildAndroidInputTextCommand,
  splitAndroidInputText,
} from "../../../utils/android-cmdline-tools/asciiKeyEvents";
import type { SystemTrayNotificationArgs } from "../systemTrayTypes";
import type { SystemTrayOutcome } from "../SystemTray";
import {
  watchReplyInput,
  watchReplySend,
  watchReplySpace,
  type WatchNotification,
} from "./watchHierarchy";

export const MAX_SETTLE_READS = 6;
export const POLL_MS = 250;

interface WatchReplyDependencies {
  signal?: AbortSignal;
  read(): Promise<ObserveResult>;
  tap(element: Element, observation: ObserveResult): Promise<void>;
  command(command: string): Promise<unknown>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Completes the watch keyboard reply without changing the active IME. */
export async function watchReply(
  text: string,
  deps: WatchReplyDependencies,
): Promise<SystemTrayOutcome> {
  const { signal } = deps;
  let observation: ObserveResult | undefined;
  for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt++) {
    await deps.sleep(POLL_MS, signal);
    observation = await deps.read();
    if (watchReplyInput(observation.viewHierarchy)) {
      break;
    }
  }
  if (!observation || !watchReplyInput(observation.viewHierarchy)) {
    throw new ActionableError(
      "Watch reply keyboard did not appear. Re-observe the notification and retry.",
    );
  }
  // Keep literal %s across separate commands so input text cannot decode it as a space.
  // Reuse bounded text chunks without changing the IME, which would close the reply screen.
  const chunks = splitAndroidInputText(text, null).flatMap((chunk) => chunk.split(/(?<=%)(?=s)/));
  for (const chunk of chunks) {
    await deps.command(buildAndroidInputTextCommand(chunk));
  }
  let space: Element | undefined;
  for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt++) {
    await deps.sleep(POLL_MS, signal);
    observation = await deps.read();
    space = watchReplySpace(observation.viewHierarchy);
    if (space) {
      break;
    }
  }
  if (!space) {
    throw new ActionableError(
      "Watch reply Space key did not appear. Re-observe the reply keyboard and retry.",
    );
  }
  await deps.tap(space, observation);
  for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt++) {
    await deps.sleep(POLL_MS, signal);
    observation = await deps.read();
    const send = watchReplySend(observation.viewHierarchy);
    if (send) {
      await deps.tap(send, observation);
      return {
        payload: {
          message: "Replied to watch notification",
          observation: await deps.read(),
          success: true,
        },
        isError: false,
      };
    }
  }
  throw new ActionableError(
    "Watch reply Send button did not appear. Re-observe the reply keyboard and retry.",
  );
}

export function watchTapLabel(
  criteria: SystemTrayNotificationArgs,
  card: WatchNotification,
): string | null {
  return (
    criteria.tapActionLabel ??
    (criteria.replyText !== undefined ? "Keyboard input" : (card.title ?? card.body))
  );
}
