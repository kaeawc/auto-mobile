import { ActionableError } from "./ActionableError";

/** A target has no tappable area outside the soft keyboard. */
export class KeyboardOcclusionError extends ActionableError {}
