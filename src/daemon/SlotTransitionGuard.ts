import { SlotTransitionError } from "./SlotTransitionError";
import {
  type SlotPosition,
  checkSlotTransition,
  COARSE_SLOT_PATHS,
  REPORTED_SLOT_TRANSITIONS,
} from "./sessionSlots";

/** Diagnostic only; hook bookkeeping is synchronous and never drives lifecycle decisions. */
export class SlotTransitionGuard {
  illegalTransitionCount = 0;
  private readonly positions = new Map<string, SlotPosition>();
  private baselineAfterReset = false;

  constructor(
    private readonly logger: { debug(message: string): void; warn(message: string): void },
  ) {}

  /** Off mode leaves unobserved transitions; resume from each UUID's first new observation. */
  reset(): void {
    this.positions.clear();
    this.baselineAfterReset = true;
  }

  /** Finalization cleanup releases ended UUID bookkeeping along with its weak identity. */
  forget(uuid: string): void {
    this.positions.delete(uuid);
  }

  check(uuid: string, event: string, to: SlotPosition, mode: "throw" | "log"): void {
    const from = this.positions.get(uuid) ?? (this.baselineAfterReset ? to : { tag: "absent" });
    if (to.tag === "absent") {
      this.positions.delete(uuid);
    } else {
      this.positions.set(uuid, { tag: to.tag, fence: to.fence });
    }
    if (from.tag === to.tag && from.fence === to.fence) {
      return;
    }
    const result = checkSlotTransition(from, to);
    if (result.ok) {
      return;
    }
    const known =
      REPORTED_SLOT_TRANSITIONS.has(`${event}:${from.tag}:${to.tag}`) ||
      COARSE_SLOT_PATHS.some(
        (path) =>
          path.event === event &&
          path.from === from.tag &&
          path.to === to.tag &&
          checkSlotTransition(from, { tag: path.via }).ok &&
          checkSlotTransition({ tag: path.via }, to).ok,
      );
    this.illegalTransitionCount++;
    const message = `[SlotTransitionGuard] uuid=${uuid} event=${event}: ${result.reason}`;
    if (known) {
      this.logger.debug(message);
      return;
    }
    if (mode === "throw") {
      throw new SlotTransitionError(from, to, message);
    }
    this.logger.warn(message);
  }
}
