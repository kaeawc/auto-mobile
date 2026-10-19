/**
 * Preserve the normal failed socket envelope while carrying append progress for
 * a client that can safely retry only the unsent suffix.
 */
export class InputTypeTextAppendError extends Error {
  constructor(
    message: string,
    readonly charsSent: number,
  ) {
    super(message);
    this.name = "InputTypeTextAppendError";
  }
}
