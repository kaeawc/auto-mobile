import { type SlotPosition } from "./sessionSlots";

export class SlotTransitionError extends Error {
  constructor(
    readonly from: SlotPosition,
    readonly to: SlotPosition,
    reason: string,
  ) {
    super(reason);
    this.name = "SlotTransitionError";
  }
}
