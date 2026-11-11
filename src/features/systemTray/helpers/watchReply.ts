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
  watchReplyText,
  type WatchNotification,
} from "./watchHierarchy";

export const MAX_SETTLE_READS = 6;
export const POLL_MS = 250;
export const REPLY_INPUT_SETTLE_MS = 750;
export const MAX_REPLY_ATTEMPTS = 3;

interface WatchReplyDependencies {
  signal?: AbortSignal;
  read(): Promise<ObserveResult>;
  tap(element: Element, observation: ObserveResult): Promise<void>;
  command(command: string): Promise<unknown>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function assertSingleWordReply(text: string): void {
  if (text.length === 0 || /\s/.test(text)) {
    throw new ActionableError(
      `Wear OS inline reply currently supports a single word because Gboard's remote input corrupts multi-word text; use a single word. Given: ${JSON.stringify(text)}.`,
    );
  }
}

/** Completes the watch keyboard reply without changing the active IME. */
export async function watchReply(
  text: string,
  deps: WatchReplyDependencies,
): Promise<SystemTrayOutcome> {
  assertSingleWordReply(text);
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
  await typeAndVerifyReply(text, deps);
  for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt++) {
    await deps.sleep(POLL_MS, signal);
    observation = await deps.read();
    const send = watchReplySend(observation.viewHierarchy);
    if (send && watchReplyText(observation.viewHierarchy) === `${text} `) {
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
    "Watch reply Send button did not appear with verified text. Re-observe the reply keyboard and retry.",
  );
}

async function typeAndVerifyReply(text: string, deps: WatchReplyDependencies): Promise<void> {
  const expected = `${text} `;
  let observed: string | undefined;
  for (let attempt = 0; attempt < MAX_REPLY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Keep the narrow command seam: ClearText's helper takes a full AdbExecutor.
      // Allow for stale captures/composition as well as the observed field length.
      const deletes = Math.max(observed?.length ?? 0, expected.length) + 2;
      await deps.command("shell input keyevent KEYCODE_MOVE_END");
      await deps.command(
        `shell input keyevent ${Array<string>(deletes).fill("KEYCODE_DEL").join(" ")}`,
      );
    }
    await deps.sleep(REPLY_INPUT_SETTLE_MS, deps.signal);
    await typeAndCommitReply(text, deps);
    for (let read = 0; read < MAX_SETTLE_READS; read++) {
      await deps.sleep(POLL_MS, deps.signal);
      observed = watchReplyText((await deps.read()).viewHierarchy);
      // Do not trim: missing words, case changes and extra whitespace must all fail closed.
      if (observed === expected) {
        return;
      }
    }
  }
  throw new ActionableError(
    `Watch reply text did not land after ${MAX_REPLY_ATTEMPTS} attempts: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed) ?? "unavailable"}. Reply was not sent. Re-observe the reply keyboard and retry.`,
  );
}

async function typeAndCommitReply(text: string, deps: WatchReplyDependencies): Promise<void> {
  // Keep literal %s across separate commands so input text cannot decode it as a space.
  // Reuse bounded text chunks without changing the IME, which would close the reply screen.
  const chunks = splitAndroidInputText(text, null).flatMap((chunk) => chunk.split(/(?<=%)(?=s)/));
  for (const chunk of chunks) {
    await deps.command(buildAndroidInputTextCommand(chunk));
  }
  let space: Element | undefined;
  let observation: ObserveResult | undefined;
  for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt++) {
    await deps.sleep(POLL_MS, deps.signal);
    observation = await deps.read();
    space = watchReplySpace(observation.viewHierarchy);
    if (space) {
      break;
    }
  }
  if (!space || !observation) {
    throw new ActionableError(
      "Watch reply Space key did not appear. Re-observe the reply keyboard and retry.",
    );
  }
  await deps.tap(space, observation);
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
