import { AndroidIdentityUnresolvedError } from "./AndroidIdentityUnresolvedError";

/** A live emulator with an unanswered AVD-name probe may be the requested image. */
export class AndroidAvdIdentityUnresolvedError extends AndroidIdentityUnresolvedError {
  constructor(
    readonly avdName: string,
    candidateSerials: readonly string[],
  ) {
    super(
      `target_identity_unresolved: Cannot prove whether Android AVD '${avdName}' is already running; ` +
        `AVD name is unavailable for ${candidateSerials.join(", ")}. Retry after identity discovery recovers.`,
      candidateSerials,
    );
  }

  override toPayload(): Record<string, unknown> {
    return { ...super.toPayload(), avdName: this.avdName };
  }
}
