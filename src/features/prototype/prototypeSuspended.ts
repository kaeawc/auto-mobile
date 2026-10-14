import { ActionableError } from "../../models/ActionableError";

/**
 * An Android session prototype is hidden, with its state kept, while the app it was shown over is
 * not in front. This is the one wording every surface uses for that condition; callers add the
 * advice that fits their action.
 */
export const PROTOTYPE_SUSPENDED_REASON =
  "the AutoMobile prototype is hidden because the app it was shown over is not in front";

/** Advice for tools that wait on the prototype rather than act on its elements. */
export const PROTOTYPE_SUSPENDED_WAIT_WARNING =
  `${PROTOTYPE_SUSPENDED_REASON}, so no events can arrive until that app is back in the foreground ` +
  "(the prototype returns with its state).";

/** A suspended prototype cannot be acted on until its host app or prototype is shown again. */
export class PrototypeSuspendedError extends ActionableError {
  readonly code = "prototype_suspended";
  readonly retryable = false;
  readonly nextAction =
    "bring the app the prototype was shown over back to the foreground (launchApp), or show the prototype again";
  readonly details = { prototypeSuspended: true };

  constructor() {
    super(
      `layer "prototype" was requested, but ${PROTOTYPE_SUSPENDED_REASON}. ` +
        "Bring that app back to the foreground (the prototype returns with its state), or omit layer.",
    );
  }
}
