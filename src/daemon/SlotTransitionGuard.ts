import { checkSlotTransition, type SlotPhase, type SlotPosition } from "./sessionSlots";
import { SlotTransitionError } from "./SlotTransitionError";

// Each skipped path is already legal in design §3.1. Hooks do not observe the absent
// admission fence between failure and cleanup, or ended while older work still covers a UUID.
const COARSE_SLOT_PATHS: readonly {
  event: string;
  from: SlotPhase;
  via: SlotPhase;
  to: SlotPhase;
}[] = [
  { event: "published", from: "absent", via: "creating", to: "live" },
  { event: "assignment-end", from: "assigning", via: "absent", to: "fenced" },
  { event: "creation-end", from: "creating", via: "absent", to: "fenced" },
  { event: "unpublished", from: "releasing", via: "ended", to: "creating" },
];

// docs/design-docs/session-state-record.md §4 "S7 guard findings" documents these
// seven §3.1 gaps and the four coarse paths above. Count both at debug: they are known
// observations, so warning or throwing would add production noise without a new finding.
// Scope each exception to its actual hook so it cannot silently bless a new transition.
const REPORTED_SLOT_TRANSITIONS = new Set([
  "assignment-start:ended:assigning", // revival first needs automatic device assignment
  "assignment-end:assigning:ended", // failed assignment reveals the old finalized identity
  "creation-end:creating:assigning", // creation clears before its covering assignment
  "creation-end:creating:ended", // failed creation reveals the old finalized identity
  "unpublished:releasing:assigning", // unpublication reveals the covering assignment
  "release-end:ended:fenced", // terminal upgrade of a finalized non-terminal release
  "release-end:ended:live", // shutdown test injects a replacement without a publish hook
]);

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
