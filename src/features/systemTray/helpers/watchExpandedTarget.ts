import { ActionableError, type Element, type ObserveResult } from "../../../models";
import { hierarchyUpdatedAtToMillis } from "../../observe/observeTimestamp";
import { MAX_SETTLE_READS, POLL_MS } from "./watchReply";
import {
  watchExpandedTarget,
  watchExpandedTargetDiagnosis,
  watchHasExpandedCard,
} from "./watchHierarchy";

interface WatchExpandedTargetDependencies {
  signal?: AbortSignal;
  read(): Promise<ObserveResult>;
  command(command: string): Promise<unknown>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The tap's error when the target never appeared, with what the last read showed (#16829). */
function missingTargetMessage(expanded: ObserveResult, text: string | null): string {
  const seen = text
    ? watchExpandedTargetDiagnosis(expanded.viewHierarchy, text)
    : "the card has no title or body to tap";
  return `Watch notification expanded target is not available. Re-observe the expanded notification and use an explicit clickable content or action label. ${seen.charAt(0).toUpperCase()}${seen.slice(1)}.`;
}

/**
 * After a card was tapped: it expands over a few hundred ms and its actions only appear once it
 * has, so re-read until the target labelled `text` shows up (bounded), and return it with the read
 * it was found in. Throws, describing the last read, when it never does.
 */
export async function awaitWatchExpandedTarget(
  observation: ObserveResult,
  text: string | null,
  deps: WatchExpandedTargetDependencies,
): Promise<{ expanded: ObserveResult; target: Element }> {
  let expanded = observation;
  let target: Element | undefined;
  // The capture each swipe was decided on. CtrlProxy can serve that same cached tree again
  // straight after the swipe; swiping on it again would scroll twice per step seen and carry the
  // action rows past the top (#16829), so a repeated capture is only read again.
  let swipedOn: number | undefined;
  for (let attempt = 0; attempt < MAX_SETTLE_READS && text && !target; attempt++) {
    await deps.sleep(POLL_MS, deps.signal);
    expanded = await deps.read();
    target = watchExpandedTarget(expanded.viewHierarchy, text);
    const capturedAt = hierarchyUpdatedAtToMillis(expanded.viewHierarchy);
    const seenBefore = capturedAt !== undefined && capturedAt === swipedOn;
    // The expanded card grows past the bottom edge and the stream does not follow it, so its
    // action rows are off screen until the stream is scrolled up (#17317).
    if (!target && !seenBefore && watchHasExpandedCard(expanded.viewHierarchy)) {
      const { width, height } = expanded.screenSize;
      await deps.command(
        `shell input swipe ${Math.floor(width / 2)} ${Math.floor(height * 0.7)} ${Math.floor(width / 2)} ${Math.floor(height * 0.35)} 400`,
      );
      swipedOn = capturedAt;
    }
  }
  if (!target) {
    throw new ActionableError(missingTargetMessage(expanded, text));
  }
  return { expanded, target };
}
