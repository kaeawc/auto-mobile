/** Preserves caller cancellation through discovery's normal miss handling. */
export class AndroidToolsDetectionAbortError extends Error {
  constructor(readonly abortError: Error) {
    super(abortError.message);
    this.name = "AndroidToolsDetectionAbortError";
  }
}
